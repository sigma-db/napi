"use strict";
const { exec } = require("child_process");
const { access, mkdirSync, rmdirSync, createWriteStream, writeFile, unlinkSync, lstat, mkdir } = require("fs");
const { get } = require("https");
const { EOL } = require("os");
const { join, relative } = require("path");
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

const exists = (path) => new Promise((resolve) => {
    access(path, err => void resolve(!err));
});

const checkInstalled = async () => new Promise(async (resolve, reject) => {
    if (!await isToolAvailable("cmake")) {
        reject("Could not find 'cmake' in the path.");
    }
    if (!await isToolAvailable("ninja")) {
        reject("Could not find 'ninja' in the path.");
    }
    if (!await exists(NODE_INCLUDE_DIR)) {
        reject("Missing header files.");
    }
    if (IS_WINDOWS && !await exists(NODE_LIB_FILE)) {
        reject("Missing library files.");
    }
    resolve(true);
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

const generateCMakeFile = (name, version) => new Promise(async (resolve, reject) => {
    const cmake = src`
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

    writeFile(CMAKE_FILE, cmake, error => !error ? resolve() : reject(error.message));
});

const generateSourceFile = (name) => new Promise((resolve, reject) => {
    const sample = src`
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

    writeFile(SRC_FILE, sample, error => !error ? resolve() : reject(error.message));
});

const generateGitIgnoreFile = () => new Promise((resolve, reject) => {
    const gitIgnore = src`
        .vscode
        ${relative(ROOT, BUILD_DIR)}
        ${relative(ROOT, NODE_HEADER_DIR)}
        ${relative(ROOT, NODE_LIB_DIR)}`;

    writeFile(GIT_IGNORE_FILE, gitIgnore, error => !error ? resolve() : reject(error.message));
});

const generatePackageJsonFile = (name) => new Promise((resolve, reject) => {
    const packageJson = src`
        \{
            "name": "${name}",
            "version": "0.0.0",
            "main": "${relative(ROOT, join(BUILD_DIR, `${name}.node`))}"
        \}`;

    writeFile(PACKAGE_JSON_FILE, packageJson, error => !error ? resolve() : reject(error.message));
});

const generateProject = (name, version) => {
    mkdir(SRC_DIR, async (err) => {
        if (!err) {
            await generateCMakeFile(name, version).catch(createErrorFunction(CMAKE_FILE));
            await generateSourceFile(name).catch(createErrorFunction(SRC_DIR));
            await generateGitIgnoreFile().catch(createErrorFunction(GIT_IGNORE_FILE));
            await generatePackageJsonFile(name).catch(createErrorFunction(PACKAGE_JSON_FILE));
        } else {
            console.error(err.message);
            process.exit(1);
        }
    });
};

const create = async (name) => {
    await install();
    if (await isToolAvailable("cmake")) {
        const version = await getCMakeVersion();
        generateProject(name, version);
    } else {
        console.error("Can not generate a CMakeLists.txt without 'cmake' in the path.");
        process.exit(1);
    }
}

const install = async () => {
    const onExit = createErrorFunction(NODE_HEADER_DIR);
    await fetchHeaders().catch(onExit);
    if (IS_WINDOWS) {
        await fetchLib().catch(onExit);
    }
}

const build = async () => {
    await checkInstalled().catch(createErrorFunction());
    await runBuild().catch(createErrorFunction(BUILD_DIR));
}

const clean = (all = false) => {
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
    case cmd === "create" && !!arg:
        console.log("Generating sample project...");
        create(arg);
        return;
    case cmd === "install":
        console.log("Fetching Node.js dependencies...");
        install();
        return;
    case cmd === "build":
        console.log("Building project...");
        build();
        return;
    case cmd === "clean":
        console.log("Cleaning up...");
        clean(arg === "all");
        return;
    default:
        console.error("None of the possible options 'create', 'install', 'build', or 'clean' were specified.");
        process.exit(1);
}

console.log("Success");
