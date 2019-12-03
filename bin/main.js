"use strict";
const { version: NAPI_VERSION } = require("../package.json");
const { spawn } = require("child_process");
const { createWriteStream } = require("fs");
const { access, mkdir, rmdir, unlink, lstat, writeFile } = require("fs").promises;
const { get } = require("https");
const { EOL } = require("os");
const { createInterface } = require("readline");
const { extract: untar } = require("tar-fs");
const { promisify } = require("util");
const { createGunzip: gunzip } = require("zlib");

// #region Constants
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
const TEST_DIR = join(ROOT, "test");
const GIT_DIR = join(ROOT, ".git");

// downloaded node files
const NODE_HEADER_DIR = join(ROOT, `node-${NODE_VERSION}`);
const NODE_INCLUDE_DIR = join(NODE_HEADER_DIR, "include", "node");
const NODE_LIB_DIR = join(ROOT, "libs");
const NODE_LIB_FILE = join(NODE_LIB_DIR, "node.lib");

// auto generated files
const SRC_FILE = join(SRC_DIR, "module.c");
const TEST_FILE = join(TEST_DIR, "index.js");
const CMAKE_LISTS_FILE = join(ROOT, "CMakeLists.txt");
const PACKAGE_JSON_FILE = join(ROOT, "package.json");
const GITIGNORE_FILE = join(ROOT, ".gitignore");
// #endregion

// #region Utilities
const which = (cmd, optional = false) => new Promise((resolve, reject) => {
    const proc = spawn(WHICH_CMD, [cmd]);
    createInterface(proc.stdout).on("line", resolve);
    proc.on("exit", code => optional ? resolve(!(code === 0 && optional)) : reject(`Could not find '${cmd}' in the path.`));
});

const verify = (cmd, optional = false) => new Promise((resolve, reject) => {
    spawn(WHICH_CMD, [cmd]).on("exit", code => code === 0 ? resolve(true) : optional ? resolve(false) : reject(`Could not find '${cmd}' in the path.`));
});

const remove = async (path, ignoreErrors = true) => {
    const stats = await lstat(path).catch(clear(null, ignoreErrors));
    if (!!stats && stats.isFile()) {
        return unlink(path);
    } else if (!!stats && stats.isDirectory()) {
        return rmdir(path, { recursive: true });
    } else if (!ignoreErrors) {
        throw new Error("Provided path neither references a file nor a directory.");
    }
};

const clear = (path, ignore = false) => async (error) => {
    !ignore && console.error(error);
    if (!!path) {
        console.log("Cleaning up...");
        if (Array.isArray(path)) {
            await Promise.all(path.map(p => remove(p))).catch(clear());
        } else if (typeof path === "string") {
            await remove(path).catch(clear());
        } else {
            console.error(`Could not clean ${path}.`);
        }
    }
    !ignore && process.exit(1);
};

const exit = (name) => async (error) => {
    process.chdir("..");
    const prjDir = join(process.cwd(), name);
    await access(prjDir);
    await rmdir(prjDir);
    console.error(error);
    process.exit(1);
};
// #endregion

// #region Commands

// #region Create
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

const MODULE_C = (name) => src`
    #include <stdlib.h>
    #include <node_api.h>
    #include <assert.h>

    napi_value Init(napi_env env, napi_value exports) {
        napi_value str;
        napi_status status = napi_create_string_utf8(env, "A project named \\"${name}\\" is growing here.", NAPI_AUTO_LENGTH, &str);
        assert(status == napi_ok);
        return str;
    }

    NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)`;

const TEST_JS = () => src`
    const val = require("${relative(TEST_DIR, ROOT)}");
    console.log(val);`;

const CMAKE_LISTS_TXT = (name, version) => src`
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
    # END N-API specific`;

const PACKAGE_JSON = (name) => src`
    {
        "name": "${name}",
        "version": "0.0.0",
        "main": "${relative(ROOT, join(BUILD_DIR, `${name}.node`)).replace("\\", IS_WINDOWS ? "\\\\" : "\\")}",
        "devDependencies": {
            "@sigma-db/napi": "^${NAPI_VERSION}"
        },
        "scripts": {
            "install": "napi init && napi build",
            "test": "napi test"
        }
    }`;

const GITIGNORE = () => src`
    .vscode
    ${relative(ROOT, BUILD_DIR)}
    ${relative(ROOT, TEST_DIR)}
    ${relative(ROOT, NODE_HEADER_DIR)}
    ${relative(ROOT, NODE_LIB_DIR)}`;

const gitInit = () => new Promise(async (resolve) =>
    await verify("git", true)
        ? spawn("git", ["init"]).on("exit", code => resolve(code === 0))
        : resolve(false)
);

const generateProject = async (name, version) => {
    await mkdir(SRC_DIR);
    await mkdir(TEST_DIR);
    await Promise.all([
        writeFile(CMAKE_LISTS_FILE, CMAKE_LISTS_TXT(name, version)),
        writeFile(SRC_FILE, MODULE_C(name)),
        writeFile(TEST_FILE, TEST_JS()),
        writeFile(PACKAGE_JSON_FILE, PACKAGE_JSON(name)),
    ]);
    if (await gitInit()) {
        await writeFile(GITIGNORE_FILE, GITIGNORE());
    } else {
        await remove(GIT_DIR, true);
    }
};

const cMakeVersion = () => new Promise((resolve, reject) => {
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
        await mkdir(prj).catch(exit(name));
        process.chdir(prj);

        await verify("cmake").catch(exit(name));
        const version = await cMakeVersion().catch(exit(name));
        await Promise.all([
            install(),
            generateProject(name, version)
        ]).catch(exit(name));
    } else {
        exit(name)("You must specify a project name.");
    }
}
// #endregion

// #region Install
const download = (path, dataHandler) => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/${path}`, dataHandler)
        .on("finish", () => resolve())
        .on("error", err => reject(err.message));
});

const install = async () => {
    await download(`node-${NODE_VERSION}-headers.tar.gz`, res => res.pipe(gunzip()).pipe(untar(ROOT))).catch(clear(NODE_HEADER_DIR));
    if (IS_WINDOWS) {
        await mkdir(NODE_LIB_DIR).catch(clear(NODE_HEADER_DIR));
        await download(`${NODE_ARCH}/node.lib`, res => res.pipe(createWriteStream(NODE_LIB_FILE))).catch(clear([NODE_HEADER_DIR, NODE_LIB_DIR]));
    }
}
// #endregion

// #region Build
const spawnAsync = (command, args, options) => new Promise((resolve, reject) => {
    const proc = spawn(command, args, options);
    const errs = [];
    proc.stderr.on("data", (chunk) => errs.push(chunk));
    proc.on("exit", (code) => {
        if (code > 0 && errs.length > 0) {
            reject(errs.join(""));
        } else if (code > 0) {
            reject(`Command ${command} finished with exit code ${code}.`);
        } else {
            resolve();
        }
    });
});

const build = async (debug = false, generator = "Ninja") => {
    // check for required tools and dirs
    await Promise.all([
        verify("cmake"),
        verify("ninja"),
        access(NODE_INCLUDE_DIR)
    ]);
    if (IS_WINDOWS) {
        await access(NODE_LIB_FILE);
    }

    // run build
    await mkdir(BUILD_DIR, { recursive: true });
    process.chdir(BUILD_DIR);
    await spawnAsync("cmake", [`-D CMAKE_BUILD_TYPE=${debug ? "Debug" : "Release"}`, `-G ${generator}`, ".."], { shell: true });
    await spawnAsync("ninja", { shell: true });
    process.chdir("..");
}
// #endregion

// #region Test
const test = async () => {
    const node = await which("node");
    const proc = spawn(node, [TEST_DIR]);
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
};
// #endregion

// #region Clean Command
const clean = async (all = false) => {
    await remove(BUILD_DIR, true);
    all && await remove(NODE_HEADER_DIR, true);
}
// #endregion
// #endregion

// #region Main
(async function main(cmd, arg) {
    switch (cmd) {
        case "new":
            console.log(`Generating project...`);
            await create(arg);
            break;
        case "init":
            console.log("Fetching Node.js dependencies...");
            await install();
            break;
        case "build":
            console.log("Building project...");
            await build().catch(clear(BUILD_DIR));
            break;
        case "test":
            console.log(`Running tests...`);
            await test();
            break;
        case "clean":
            console.log("Cleaning up...");
            await clean(arg === "all");
            break;
        default:
            console.error("None of the possible options 'create <name>', 'install', 'build', or 'clean' were specified.");
            process.exit(1);
    }
})(process.argv[2], process.argv[3]);
// #endregion
