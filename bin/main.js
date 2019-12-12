"use strict";
const { version: PACKAGE_VERSION } = require("../package.json");
const { ok } = require("assert").strict;
const { spawn } = require("child_process");
const { createWriteStream } = require("fs");
const { access, mkdir, rmdir, unlink, lstat, writeFile } = require("fs").promises;
const { get } = require("https");
const { EOL } = require("os");
const { createInterface } = require("readline");
const { extract: untar } = require("tar-fs");
const { createGunzip: gunzip } = require("zlib");

// #region Constants
// platform specific stuff
const { node: NODE_SEMVER_VERSION, napi: NAPI_VERSION } = process.versions;
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
const GIT_DIR = join(ROOT, ".git");

// downloaded node files
const NODE_HEADER_DIR = join(ROOT, `node-${NODE_VERSION}`);
const NODE_INCLUDE_DIR = join(NODE_HEADER_DIR, "include", "node");
const NODE_LIB_DIR = join(ROOT, "libs");
const NODE_LIB_FILE = join(NODE_LIB_DIR, "node.lib");

// auto generated files
const SRC_FILE = join(SRC_DIR, "module.cpp");
const CMAKE_LISTS_FILE = join(ROOT, "CMakeLists.txt");
const NAPI_CMAKE_FILE = join(ROOT, "napi.cmake");
const PACKAGE_JSON_FILE = join(ROOT, "package.json");
const GITIGNORE_FILE = join(ROOT, ".gitignore");
// #endregion

// #region Utilities
/*const which = (cmd, optional = false) => new Promise((resolve, reject) => {
    const proc = spawn(WHICH_CMD, [cmd]);
    createInterface(proc.stdout).on("line", resolve);
    proc.on("exit", code => optional ? resolve(!(code === 0 && optional)) : reject(`Could not find '${cmd}' in the path.`));
});*/

const verify = (cmd, optional = false) => new Promise((resolve, reject) => {
    spawn(WHICH_CMD, [cmd]).on("exit", code => optional ? resolve(!(code === 0 && optional)) : reject(`Could not find '${cmd}' in the path.`));
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
            await Promise.all(path.map(p => remove(p, true))).catch(clear());
        } else if (typeof path === "string") {
            await remove(path).catch(clear());
        } else {
            console.error(`Could not clean ${path}.`);
        }
    }
    !ignore && process.exit(1);
};

const exit = (name) => async (error) => {
    process.chdir(ROOT);
    const prjDir = join(process.cwd(), name);
    try {
        const stats = lstat(path);
        if (!!stats && stats.isDirectory()) {
            await rmdir(prjDir);
        }
    } catch { }
    console.error(error);
    process.exit(1);
};

const download = (path, dataHandler) => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/${path}`, dataHandler)
        .on("finish", resolve)
        .on("error", err => reject(err.message));
});

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

const initGit = () => new Promise(async (resolve) => {
    await verify("git", true)
        ? spawn("git", ["init"]).on("exit", code => resolve(code === 0))
        : resolve(false)
});

const getCMakeVersion = () => new Promise((resolve, reject) => {
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
// #endregion

// #region Generated Files
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

const CMAKE_LISTS_TXT = (name, version) => src`
    cmake_minimum_required(VERSION ${version})
    project(${name})

    set(CMAKE_C_STANDARD 99)

    add_library(\${PROJECT_NAME} SHARED "src/module.cpp")
    set_target_properties(\${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

    include(${NAPI_CMAKE_FILE})`;

const NAPI_CMAKE = () => src`
    include_directories(node-${NODE_VERSION}/include/node)
    if(WIN32)
        find_library(NODE_LIB node libs)
        target_link_libraries(\${PROJECT_NAME} \${NODE_LIB})
    endif()
    add_definitions(-DNAPI_VERSION=${NAPI_VERSION})`;

const PACKAGE_JSON = (name) => src`
    {
        "name": "${name}",
        "version": "0.0.0",
        "main": "${relative(ROOT, join(BUILD_DIR, `${name}.node`)).replace("\\", IS_WINDOWS ? "\\\\" : "\\")}",
        "devDependencies": {
            "@sigma-db/napi": "^${PACKAGE_VERSION}"
        },
        "engines": {
            "node": ">=${NODE_SEMVER_VERSION}"
        },
        "scripts": {
            "install": "napi init && napi build"
        }
    }`;

const GITIGNORE = () => src`
    .vscode
    ${relative(ROOT, BUILD_DIR)}
    ${relative(ROOT, NODE_HEADER_DIR)}
    ${relative(ROOT, NODE_LIB_DIR)}
    ${relative(ROOT, NAPI_CMAKE_FILE)}`;
// #endregion

// #region Commands
const create = async (name) => {
    // verify tools and versions
    await verify("cmake");
    await verify("ninja");
    const version = await getCMakeVersion();

    // build folder structure
    await mkdir(join(ROOT, name));
    process.chdir(join(ROOT, name));
    await mkdir(SRC_DIR);

    // generate default files
    await Promise.all([
        writeFile(CMAKE_LISTS_FILE, CMAKE_LISTS_TXT(name, version)),
        writeFile(SRC_FILE, MODULE_C(name)),
        writeFile(PACKAGE_JSON_FILE, PACKAGE_JSON(name)),
    ]);

    // optionally init git
    await (initGit() ? writeFile(GITIGNORE_FILE, GITIGNORE()) : remove(GIT_DIR, true));
}

const init = async () => {
    await download(`node-${NODE_VERSION}-headers.tar.gz`, res => res.pipe(gunzip()).pipe(untar(ROOT)));
    if (IS_WINDOWS) {
        await mkdir(NODE_LIB_DIR);
        await download(`${NODE_ARCH}/node.lib`, res => res.pipe(createWriteStream(NODE_LIB_FILE)));
    }
    await writeFile(NAPI_CMAKE_FILE, NAPI_CMAKE());
}

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

const clean = async (all = false) => {
    await remove(BUILD_DIR, true);
    all && await remove(NODE_HEADER_DIR, true);
}
// #endregion

(async function main(cmd, arg) {
    switch (cmd) {
        case "new":
            ok(!!arg, "You must specify a project name.");
            console.log("Generating project...");
            await create(arg).catch(exit(arg));
            break;
        case "init":
            console.log("Fetching Node.js dependencies...");
            await init().catch(clear([NODE_HEADER_DIR, NODE_LIB_DIR, BUILD_DIR, NAPI_CMAKE_FILE], true));
            break;
        case "build":
            const debug = !!arg && arg.toLowerCase() === "debug";
            console.log(`Building project in ${debug ? "debug" : "release"} mode...`);
            await build(debug).catch(clear(BUILD_DIR));
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
