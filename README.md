# N-API CLI

[![NPM](https://img.shields.io/npm/v/@sigma-db/napi)](https://www.npmjs.com/package/@sigma-db/napi)
![node version](https://img.shields.io/node/v/@sigma-db/napi)

This project eases the process of setting up an environment for developing [native Node.js modules](https://nodejs.org/dist/latest-v13.x/docs/api/n-api.html) by fetching the correct architecture- and OS-specific header and library files as well as preparing the `CMakeLists.txt` acxcordingly.

## Prerequisites

Currently, this tool requires `cmake` and `ninja` to be in your `PATH`, as well as a working C/C++ toolchain.

* On **Windows**, you can use the [Visual Studio Build Tools](https://download.visualstudio.microsoft.com/download/pr/5446351f-19f5-4b09-98c6-a4bfacc732d7/7da4388648c92544c97407c6f052fd6bc0317db407cadab9fdcb328a34d3e317/vs_BuildTools.exe) which includes all required tools. In that case, make sure that you use the appropriate *Tools Command Prompt for Visual Studio*
* On **Linux** and other **UNIX**-like environments, make sure to have `cmake`, `ninja`, `clang`/`gcc` and `ld` available in your `PATH`.

## Installation

Run `npm i -g @sigma-db/napi` to install the `napi` CLI globally.

## Usage

Assume we want to create and build a project named `native`.

1. **create** the project and change into its directory by running `napi new native && cd native`.

2. **initialise** the project by running `napi init` from within the project directory to automatically download the appropriate header and static library files.

3. **build** the project by running `napi build` from within the project directory.

4. **test** that requiring your native module actually works by running `napi test` from within the project directory. You should see an output like `A project named "native" is growing here.`

5. **clean** any files generated during the build by running `napi clean` from within the project directory. Note that doing this will make `CMake` run again on the next build, considerably increasing the build time of the next build.

### Changing the Node.js version

If you happen to change your version of Node.js, you also need new header and static library files. In that case, run `napi clean all`, which will delete any previously downloaded header and library files, as well as any built files.
