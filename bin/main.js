"use strict";
const { exec } = require('child_process');
const { mkdirSync, createWriteStream, rmdirSync } = require("fs");
const { get } = require("https");
const { join } = require("path");
const { extract } = require("tar-fs");
const { createGunzip } = require("zlib");

const NODE_VERSION = process.version;
const IS_WINDOWS = process.platform === "win32"
const NODE_ARCH_WIN = process.arch === "x64" ? "win-x64" : "win-x86";
const DIST_BASE_URL = `https://nodejs.org/dist/${NODE_VERSION}`;
const ROOT = ".";

const isToolAvailable = (tool) => new Promise(resolve => {
    exec(`${IS_WINDOWS ? "where" : "which"} ${tool}`).on("exit", code => resolve(code == 0));
});

const buildCMakeParams = ({ vars, generator } = { vars: [], generator: "Ninja" }) => {
    const varsStr = Object.entries(vars).map(([k, v]) => `-D ${k}=${v}`).join(" ");
    const generatorStr = `-G ${generator}`;
    return `${varsStr} ${generatorStr}`;
}

const fetchHeaders = () => new Promise((resolve, reject) => {
    get(`${DIST_BASE_URL}/node-${NODE_VERSION}-headers.tar.gz`, res => res.pipe(createGunzip()).pipe(extract(ROOT))
        .on("finish", () => resolve()))
        .on("error", err => reject(err.message));
});

const fetchLib = () => new Promise((resolve, reject) => {
    const libDirPath = join(ROOT, `node-${NODE_VERSION}`, NODE_ARCH_WIN);
    mkdirSync(libDirPath);
    get(`${DIST_BASE_URL}/${NODE_ARCH_WIN}/node.lib`, res => res.pipe(createWriteStream(join(libDirPath, "node.lib"))))
        .on("finish", () => resolve())
        .on("error", err => reject(err.message));
});

const runBuild = () => new Promise((resolve, reject) => {
    const cMakeOptions = buildCMakeParams({
        generator: "Ninja",
        vars: {
            "NODE_VERSION": NODE_VERSION,
            "NODE_ARCH": NODE_ARCH_WIN,
            "CMAKE_BUILD_TYPE": "Release",
        }
    });

    const cmd = [
        "mkdir build",
        "cd build",
        `cmake ${cMakeOptions} ..`,
        "ninja"
    ].join(" && ");

    exec(cmd).on("exit", code => code == 0 ? resolve() : reject(`Build process exited with code ${code}.`));
});

const makeOnExitFunction = (path) => {
    return error => {
        console.error(error);
        console.log("Cleaning up...");
        rmdirSync(join(ROOT, path), { recursive: true });
        process.exit(1);
    };
}

const init = async () => {
    console.log(`Downloading header files...`);
    const onExit = makeOnExitFunction(`node-${NODE_VERSION}`);
    await fetchHeaders().catch(onExit);
    if (IS_WINDOWS) {
        console.log(`Downloading library required on Windows...`);
        await fetchLib().catch(onExit);
    }
    console.log("Done.")
}

const build = async () => {
    console.log("Checking for required build tools...")
    if (!await isToolAvailable("cmake")) {
        console.error("Could not find 'cmake' in the path.");
    } else if (!await isToolAvailable("ninja")) {
        console.error("Could not find 'ninja' in the path.");
    } else {
        console.log(`Building project...`);
        await runBuild().catch(makeOnExitFunction("build"));
        console.log("Done.")
    }
}

const clean = () => {
    console.log("Cleaning up...");
    try {
        rmdirSync(join(ROOT, "build"), { recursive: true });
        rmdirSync(join(ROOT, `node-${NODE_VERSION}`), { recursive: true });
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
