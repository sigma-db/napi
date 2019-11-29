"use strict";
const { spawn } = require("child_process");
const { createWriteStream } = require("fs");
const { access, mkdir, rmdir, unlink, lstat, writeFile } = require("fs").promises;
const { get } = require("https");
const { EOL } = require("os");
const { createInterface } = require("readline");
const { extract: untar } = require("tar-fs");
const { createGunzip: gunzip } = require("zlib");
const { version } = require("../package.json");

// #region Constant Declarations
// platform specific stuff
const NODE_VERSION = process.version;
const IS_WINDOWS = process.platform === "win32"
const NODE_ARCH = process.arch === "x64" ? "win-x64" : "win-x86";
const { join, relative } = IS_WINDOWS ? require("path").win32 : require("path");
const WHICH_CMD = IS_WINDOWS ? join(process.env.WINDIR, "System32", "where.exe") : "/usr/bin/which";

// base URL for all node binary distribution and header files
const DIST_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;

// the directory we will be working in
const ROOT = ".";

// generated dirs
const BUILD_DIR = join(ROOT, "build");
const SRC_DIR = join(ROOT, "src");

// constants regarding the structure of the downloaded node files
const NODE_HEADER_DIR = join(ROOT, `node-${NODE_VERSION}`);
const NODE_INCLUDE_DIR = join(NODE_HEADER_DIR, "include", "node");
const NODE_LIB_DIR = join(ROOT, "libs");
const NODE_LIB_FILE = join(NODE_LIB_DIR, "node.lib");

// auto generated files
const CMAKE_FILE = join(ROOT, "CMakeLists.txt");
const SRC_FILE = join(SRC_DIR, "module.c");
const GIT_IGNORE_FILE = join(ROOT, ".gitignore");
const PACKAGE_JSON_FILE = join(ROOT, "package.json");
// #endregion

// #region Utilities
const verifyCmd = (cmd) => new Promise((resolve, reject) => {
    spawn(WHICH_CMD, [cmd]).on("exit", code => code === 0 ? resolve() : reject(`Could not find '${cmd}' in the path.`));
});

const removeFile = async (path, ignoreErrors = true) => {
    const stats = await lstat(path).catch(catchFunction(null, ignoreErrors));
    if (!!stats && stats.isFile()) {
        return unlink(path);
    } else if (!!stats && stats.isDirectory()) {
        return rmdir(path, { recursive: true });
    } else if (!ignoreErrors) {
        throw new Error("Provided path neither references a file nor a directory.");
    }
};

const catchFunction = (path, ignore = false) => async (error) => {
    !ignore && console.error(error);
    if (!!path) {
        console.log("Cleaning up...");
        if (Array.isArray(path)) {
            await Promise.all(path.map(p => removeFile(p))).catch(catchFunction());
        } else if (typeof path === "string") {
            await removeFile(path).catch(catchFunction());
        } else {
            console.error(`Could not clean ${path}.`);
        }
    }
    !ignore && process.exit(1);
};
// #endregion

// #region Create Command
const src = (strings, ...keys) => {
    let lines = strings.reduce((res, str, idx) => `${res}${keys[idx - 1]}${str}`).split("\n");
    if (lines.length) {
        let depth = 0;
        while (!lines[0]) lines.shift();
        while (!lines[lines.length - 1]) lines.pop();
        while (lines[0].charAt(depth) === " ") depth++;
        return lines.map(str => str.substring(depth)).join(EOL);
    } else {
        return "";
    }
}

const generateCMakeListsFile = (name, version) => writeFile(CMAKE_FILE, src`
    cmake_minimum_required(VERSION ${version})
    project(${name})

    set(CMAKE_C_STANDARD 99)

    add_library(\${PROJECT_NAME} SHARED "src/module.c")
    set_target_properties(\${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

    # BEGIN N-API specific
    include_directories(node-${NODE_VERSION}/include/node)
    if(WIN32)
        find_library(NODE_LIB node libs)
        target_link_libraries(\${PROJECT_NAME} \${NODE_LIB})
    endif()
    add_definitions(-DNAPI_VERSION=5)
    # END N-API specific`
);

const generateSourceFile = (name) => writeFile(SRC_FILE, src`
    #include <stdlib.h>
    #include <node_api.h>
    #include <assert.h>

    napi_value Init(napi_env env, napi_value exports) {
        napi_value str;
        napi_status status = napi_create_string_utf8(env, "A project named ${name} is growing here.", NAPI_AUTO_LENGTH, &str);
        assert(status == napi_ok);
        return str;
    }

    NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)`
);

const generateGitIgnoreFile = () => writeFile(GIT_IGNORE_FILE, src`
    .vscode
    ${relative(ROOT, BUILD_DIR)}
    ${relative(ROOT, NODE_HEADER_DIR)}
    ${relative(ROOT, NODE_LIB_DIR)}`
);

const generatePackageJsonFile = (name) => writeFile(PACKAGE_JSON_FILE, src`
    {
        "name": "${name}",
        "version": "0.0.0",
        "main": "${relative(ROOT, join(BUILD_DIR, `${name}.node`))}",
        "devDependencies": {
            "@sigma-db/napi": "^${version}"
        },
        "scripts": {
            "build": "napi build",
            "install": "napi init"
        }
    }`
);

const generateProject = async (name, version) => {
    await mkdir(SRC_DIR).catch(catchFunction());
    await Promise.all([
        generateCMakeListsFile(name, version).catch(catchFunction(CMAKE_FILE)),
        generateSourceFile(name).catch(catchFunction(SRC_DIR)),
        generateGitIgnoreFile().catch(catchFunction(GIT_IGNORE_FILE)),
        generatePackageJsonFile(name).catch(catchFunction(PACKAGE_JSON_FILE))
    ]);
};

const cMakeVersion = () => new Promise(async (resolve) => {
    await verifyCmd("cmake").catch(catchFunction());
    let done = false;
    createInterface(spawn("cmake", ["--version"]).stdout)
        .on("line", line => {
            if (!done) {
                const version = /(\d+\.\d+\.\d+)/g.exec(line)[1];
                resolve(version);
            }
            done = true;
        })
        .on("close", () => !done && reject(`Could not parse your "cmake" version.`));
});

const create = async (name) => {
    if (name) {
        const prj = join(process.cwd(), name);
        await mkdir(prj).catch(catchFunction());
        await access(prj).catch(catchFunction());
        process.chdir(prj);

        const version = await cMakeVersion().catch(catchFunction());
        await Promise.all([
            install(),
            generateProject(name, version)
        ]);
    } else {
        await catchFunction()("You must specify a project name.");
    }
}
// #endregion

// #region Install Command
const fetchHeaders = () => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/node-${NODE_VERSION}-headers.tar.gz`, res => res.pipe(gunzip()).pipe(untar(ROOT))
        .on("finish", () => resolve()))
        .on("error", err => reject(err.message));
});

const fetchLib = () => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/${NODE_ARCH}/node.lib`, res => res.pipe(createWriteStream(NODE_LIB_FILE)))
        .on("finish", () => resolve())
        .on("error", err => reject(err.message));
});

const install = async () => {
    await fetchHeaders().catch(catchFunction(NODE_HEADER_DIR));
    if (IS_WINDOWS) {
        await mkdir(NODE_LIB_DIR).catch(catchFunction(NODE_HEADER_DIR));
        await fetchLib().catch(catchFunction([NODE_HEADER_DIR, NODE_LIB_DIR]));
    }
}
// #endregion

// #region Build Command
const verifyEnvironment = async () => {
    await verifyCmd("cmake");
    await verifyCmd("ninja");
    await access(NODE_INCLUDE_DIR);
    if (IS_WINDOWS) {
        await access(NODE_LIB_FILE);
    }
};

const executeBuild = (debug = false, generator = "Ninja") => new Promise((resolve, reject) => {
    const params = `-D CMAKE_BUILD_TYPE=${debug ? "Debug" : "Release"} -G ${generator}`;
    const cmd = [
        "mkdir build",
        "cd build",
        `cmake ${params} ..`,
        "ninja"
    ].join(" && ");
    spawn(cmd, { shell: true }).on("exit", code => code == 0 ? resolve() : reject(`Build process exited with error code ${code}.`));
});

const build = async () => {
    await verifyEnvironment().catch(catchFunction());
    await executeBuild().catch(catchFunction(BUILD_DIR));
}
// #endregion

// #region Clean Command
const clean = async (all = false) => {
    await removeFile(BUILD_DIR, true);
    if (all) {
        await removeFile(NODE_HEADER_DIR, true);
    }
}
// #endregion

// #region Entry Point
const [, , cmd, arg] = process.argv;
switch (cmd) {
    case "create":
    case "new":
        console.log(`Generating project...`);
        create(arg);
        break;
    case "install":
    case "init":
        console.log("Fetching Node.js dependencies...");
        install();
        break;
    case "build":
        console.log("Building project...");
        build();
        break;
    case "clean":
        console.log("Cleaning up...");
        clean(arg === "all");
        break;
    default:
        console.error("None of the possible options 'create', 'install', 'build', or 'clean' were specified.");
        process.exit(1);
}
// #endregion
