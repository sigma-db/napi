# N-API CLI

This project eases the process of setting up an environment for developing [native Node.js modules](https://nodejs.org/dist/latest-v13.x/docs/api/n-api.html) by fetching the correct architecture- and OS-specific header and library files as well as preparing the `CMakeLists.txt` acxcordingly.

## Prerequisites

Currently, this tool requires `cmake` and `ninja` to be in your `PATH`, as well as a working C/C++ toolchain.

* On Windows, you can use the [Visual Studio Build Tools](https://download.visualstudio.microsoft.com/download/pr/5446351f-19f5-4b09-98c6-a4bfacc732d7/7da4388648c92544c97407c6f052fd6bc0317db407cadab9fdcb328a34d3e317/vs_BuildTools.exe) which includes all required tools.
* On Linux or UNIX-like environments, make sure to have `cmake`, `ninja`, `clang`/`gcc` and `ld` available in your `PATH`.

## Installation

Run `npm i -g @sigma-db/napi` to install the `napi` CLI globally.

## Usage

Assume we want to create and build a project named `napi-module`.

To **create** a that project and change into its newly generated directory, simply run `napi new napi-module && cd napi-module`.

To **build** the auto-generated sample project, run `napi build` from within the project directory.

To **test** that requiring your native module actually works, run `napi test` from within the project directory.
You should see a brief output like
> A project named `napi-module` is growing here.

To **clean** any files generated during the build, run `napi clean` from within the project directory.
In case you also want to remove any downloaded headers and static libraries, run `napi clean all`.

### Note

On Linux (or WSL in Windows), running `./install.sh napi-module` will try to acquire the npm package and create, build, test and clean a sample project.

```bash
#!/bin/bash
function check {
    command -v napi &>/dev/null
    code=$?
    if [ code -gt 0 ]; then
        npm i -g @sigma-db/napi &>/dev/null
        code=$?
        if [ code -gt 0 ]; then
            echo "Could not install napi."
        fi
    fi
    return code
}

check "napi" && napi new $1 && cd $1 && napi build && napi test && napi clean all
```

## Disclaimer

I created this project to simplify creation of native Node.js modules I create, which admittedly mostly takes place on Windows and (occasionally) Linux, so don't expect it to run on *any* platform.

The current code was written in a single 16h session and might need quite some refactoring and more user-friendly error-handling — I'd love to see people contributing to this project.
