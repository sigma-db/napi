"use strict";
const { exec } = require('child_process');
const { access, mkdirSync, rmdirSync, createWriteStream, writeFile } = require("fs");
const { get } = require("https");
const { EOL } = require("os");
const { join } = require("path");
const { extract: untar } = require("tar-fs");
const { createGunzip: gunzip } = require("zlib");

// constants regarding the architecture and OS node currently runs on
const NODE_VERSION = process.version;
const IS_WINDOWS = process.platform === "win32"
const NODE_ARCH = process.arch === "x64" ? "win-x64" : "win-x86";

// base URL for all node binary distribution and header files
const DIST_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;

// the directory we will be working in
const ROOT = process.cwd();

// the directory any build files will be written to
const BUILD_DIR = join(ROOT, "build");

// constants regarding the structure of the downloaded node files
const NODE_ROOT_DIR = join(ROOT, `node-${NODE_VERSION}`);
const NODE_INCLUDE_DIR = join(NODE_ROOT_DIR, "include", "node");
const NODE_LIB_DIR = join(NODE_ROOT_DIR, NODE_ARCH);
const NODE_LIB_FILE = join(NODE_LIB_DIR, "node.lib");

// the path to the file to be icnluded in order for using the N-API
const CMAKE_FILE = join(NODE_ROOT_DIR, "napi.cmake");

// the command to use for checking whether an application is available in the path
const WHICH_CMD = IS_WINDOWS ? "where" : "which";

const isToolAvailable = (tool) => new Promise(resolve => {
    exec(`${WHICH_CMD} ${tool}`).on("exit", code => resolve(code == 0));
});

const buildCMakeParams = ({ vars, generator } = { vars: [], generator: "Ninja" }) => {
    const varsStr = Object.entries(vars).map(([k, v]) => `-D ${k}=${v}`).join(" ");
    const generatorStr = `-G ${generator}`;
    return `${varsStr} ${generatorStr}`;
}

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

const runBuild = (CMAKE_BUILD_TYPE = "Release") => new Promise((resolve, reject) => {
    const params = buildCMakeParams({
        generator: "Ninja",
        vars: { NODE_VERSION, NODE_ARCH, CMAKE_BUILD_TYPE }
    });

    const cmd = [
        "mkdir build",
        "cd build",
        `cmake ${params} ..`,
        "ninja"
    ].join(" && ");

    exec(cmd).on("exit", code => code == 0 ? resolve() : reject(`Build process exited with error code ${code}.`));
});

const createOnExitFunction = (path) => {
    return (error) => {
        console.error(error);
        if (!!path) {
            console.log("Cleaning up...");
            rmdirSync(path, { recursive: true });
        }
        process.exit(1);
    };
}

const exists = (path) => new Promise((resolve) => {
    access(path, err => void resolve(!err));
});

const isInit = async () => {
    let isInit = await exists(NODE_INCLUDE_DIR);
    if (IS_WINDOWS) {
        isInit = isInit && await exists(NODE_LIB_FILE);
    }
    return isInit;
};

const generateCMakeFile = () => new Promise((resolve, reject) => {
    const windows = IS_WINDOWS ? [
        `find_library(NODE_LIB node \${CMAKE_CURRENT_LIST_DIR}/${NODE_ARCH})`,
        "target_link_libraries(${PROJECT_NAME} ${NODE_LIB})"
    ] : [];
    const cmake = [
        "include_directories(${CMAKE_CURRENT_LIST_DIR}/include/node)",
        ...windows,
        "add_definitions(-DNAPI_VERSION=5)"
    ];
    writeFile(CMAKE_FILE, cmake.join(EOL), error => !error ? resolve() : reject(error.message));
});

const init = async () => {
    console.log(`Downloading header files...`);
    const onExit = createOnExitFunction(NODE_ROOT_DIR);
    await fetchHeaders().catch(onExit);
    if (IS_WINDOWS) {
        console.log(`Downloading library required on Windows...`);
        await fetchLib().catch(onExit);
    }
    console.log(`Generating file 'napi.cmake' to be included in your CMakeLists.txt...`);
    await generateCMakeFile().catch(onExit);
    console.log("Done.")
}

const build = async () => {
    if (!await isInit()) {
        createOnExitFunction()("Could not find appropriate header files. Did you miss to run 'napi-cli init'?");
    }
    console.log("Checking for required build tools...")
    if (!await isToolAvailable("cmake")) {
        console.error("Could not find 'cmake' in the path.");
    } else if (!await isToolAvailable("ninja")) {
        console.error("Could not find 'ninja' in the path.");
    } else {
        console.log(`Building project...`);
        await runBuild().catch(createOnExitFunction(BUILD_DIR));
        console.log("Done.")
    }
}

const clean = () => {
    console.log("Cleaning up...");
    try {
        rmdirSync(BUILD_DIR, { recursive: true });
        rmdirSync(NODE_ROOT_DIR, { recursive: true });
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}

switch (process.argv[2]) {
    case "init":
        init();
        break;
    case "build":
        build();
        break;
    case "clean":
        clean();
        break;
    default:
        console.error("None of the possible options 'init', 'build', or 'clean' were specified");
        process.exit(1);
}
