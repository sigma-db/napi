"use strict";
const { exec } = require('child_process');
const { access, mkdirSync, rmdirSync, renameSync, createWriteStream, writeFile, unlinkSync, lstat, mkdir } = require("fs");
const { get } = require("https");
const { EOL } = require("os");
const { join } = require("path");
const { createInterface } = require("readline");
const { extract: untar } = require("tar-fs");
const { createGunzip: gunzip } = require("zlib");

const NODE_VERSION = process.version;
const IS_WINDOWS = process.platform === "win32"
const NODE_ARCH = process.arch === "x64" ? "win-x64" : "win-x86";

// base URL for all node binary distribution and header files
const DIST_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;

// the directory we will be working in
const ROOT = process.cwd();

// the directory any build files will be written to
const BUILD_DIR = join(ROOT, "build");

// the source file root directory
const SRC_DIR = join(ROOT, "src");
const SRC_FILE = join(SRC_DIR, "module.c");

// constants regarding the structure of the downloaded node files
const NODE_HEADER_DIR = join(ROOT, `node-${NODE_VERSION}`);
const NODE_INCLUDE_DIR = join(NODE_HEADER_DIR, "include", "node");
const NODE_LIB_DIR = join(ROOT, "libs");
const NODE_LIB_FILE = join(NODE_LIB_DIR, "node.lib");

// the path to the file to be icnluded in order for using the N-API
const CMAKE_FILE = join(ROOT, "CMakeLists.txt");

// the command to use for checking whether an application is available in the path
const WHICH_CMD = IS_WINDOWS ? "where" : "which";

const isToolAvailable = (tool) => new Promise(resolve => {
    exec(`${WHICH_CMD} ${tool}`).on("exit", code => resolve(code == 0));
});

const getCMakeVersion = () => new Promise((resolve) => {
    let done = false;
    createInterface(exec("cmake --version").stdout).on("line", line => {
        if (!done) {
            const version = /(\d+\.\d+\.\d+)/g.exec(line)[1];
            resolve(version);
        }
        done = true;
    });
});

const fetchHeaders = () => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/node-${NODE_VERSION}-headers.tar.gz`, res => res.pipe(gunzip()).pipe(untar(ROOT))
        .on("finish", () => resolve()))
        .on("error", err => reject(err.message));
});

const fetchLib = () => new Promise((resolve, reject) => {
    mkdirSync(NODE_LIB_DIR);
    get(`${DIST_BASE_URL}/${NODE_ARCH}/node.lib`, res => res.pipe(createWriteStream(NODE_LIB_FILE)))
        .on("finish", () => resolve())
        .on("error", err => reject(err.message));
});

const runBuild = (debug = false, generator = "Ninja") => new Promise((resolve, reject) => {
    const params = `-D CMAKE_BUILD_TYPE=${debug ? "Debug" : "Release"} -G ${generator}`;
    const cmd = [
        "mkdir build",
        "cd build",
        `cmake ${params} ..`,
        "ninja"
    ].join(" && ");
    exec(cmd).on("exit", code => code == 0 ? resolve() : reject(`Build process exited with error code ${code}.`));
});

const remove = (path) => new Promise((resolve, reject) => {
    lstat(path, (err, stats) => {
        if (err) {
            reject(err.message);
        } else if (stats.isFile()) {
            unlinkSync(path);
            resolve();
        } else if (stats.isDirectory()) {
            rmdirSync(path, { recursive: true });
            resolve();
        } else {
            reject("Provided path neither references a file nor a directory.");
        }
    })
});

const createErrorFunction = (path) => {
    return async (error) => {
        console.error(error);
        if (!!path) {
            console.log("Cleaning up...");
            if (Array.isArray(path)) {
                for (let p of path) {
                    await remove(p);
                }
            } else if (typeof path === "string") {
                await remove(path);
            } else {
                console.error(`Could not clean ${path}.`);
            }
        }
        process.exit(1);
    };
}

const exists = (path) => new Promise((resolve) => {
    access(path, err => void resolve(!err));
});

const checkInit = async () => new Promise(async (resolve, reject) => {
    if (!await exists(NODE_INCLUDE_DIR)) {
        reject("Missing header files.");
    }
    if (IS_WINDOWS && !await exists(NODE_LIB_FILE)) {
        reject("Missing library files.");
    }
    resolve();
});

const unindent = (strings, ...keys) => {
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

const generateCMakeFile = (name) => new Promise(async (resolve, reject) => {
    const cmakeVersion = await getCMakeVersion();
    const cmake = unindent`
        cmake_minimum_required(VERSION ${cmakeVersion})
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
    writeFile(CMAKE_FILE, cmake, error => !error ? resolve() : reject(error.message));
});

const generateSourceFile = (name) => new Promise((resolve, reject) => {
    const src = unindent`
        #include <stdlib.h>
        #include <node_api.h>
        #include <assert.h>

        napi_value Init(napi_env env, napi_value exports) {
            napi_value str;
            napi_status status = napi_create_string_utf8(env, "A project named ${name} is growing here.", NAPI_AUTO_LENGTH, &str);
            assert(status == napi_ok);
            return str;
        }

        NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)`;

    mkdir(SRC_DIR, (err) => {
        if (err) reject(err.message);
        else writeFile(SRC_FILE, src, error => !error ? resolve() : reject(error.message))
    });
});

const create = async (name) => {
    console.log(`Generating sample project files...`);
    await generateCMakeFile(name).catch(createErrorFunction(CMAKE_FILE));
    await generateSourceFile().catch(createErrorFunction(SRC_DIR));
    await init();
}

const init = async () => {
    const onExit = createErrorFunction(NODE_HEADER_DIR);

    console.log(`Downloading Node.js header files...`);
    await fetchHeaders().catch(onExit);

    if (IS_WINDOWS) {
        console.log(`Downloading Node.js library files required on Windows...`);
        await fetchLib().catch(onExit);
    }
    console.log("Done.")
}

const build = async () => {
    !await checkInit().catch(createErrorFunction());
    console.log("Checking for required build tools...")
    if (!await isToolAvailable("cmake")) {
        console.error("Could not find 'cmake' in the path.");
    } else if (!await isToolAvailable("ninja")) {
        console.error("Could not find 'ninja' in the path.");
    } else {
        console.log(`Building project...`);
        await runBuild().catch(createErrorFunction(BUILD_DIR));
        console.log("Done.")
    }
}

const clean = (all = false) => {
    console.log("Cleaning up...");
    try {
        rmdirSync(BUILD_DIR, { recursive: true });
        if (all) {
            rmdirSync(NODE_HEADER_DIR, { recursive: true });
        }
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

const [, , cmd, arg] = process.argv;
switch (true) {
    case cmd === "new" && !!arg:
        create(arg);
        return;
    case cmd === "init":
        init();
        return;
    case cmd === "build":
        build();
        return;
    case cmd === "clean":
        clean(arg === "all");
        return;
    default:
        console.error("None of the possible options 'init', 'build', or 'clean' were specified.");
        process.exit(1);
}
