import { dlopen, FFIType, ptr } from "bun:ffi";
import { readlinkSync } from "node:fs";

// struct proc_vnodepathinfo from <sys/proc_info.h>: the current directory's
// vnode_info (152 bytes) comes first, then its MAXPATHLEN path.
const PROC_PIDVNODEPATHINFO = 9;
const vnodeInfoSize = 152;
const maxPathLength = 1024;
const vnodePathInfoSize = 2 * (vnodeInfoSize + maxPathLength);

let libproc: ReturnType<typeof openLibproc> | undefined;

function openLibproc() {
  return dlopen("libproc.dylib", {
    proc_pidinfo: { args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
}

export function processCwd(pid: number): string | undefined {
  try {
    if (process.platform !== "darwin") return readlinkSync(`/proc/${pid}/cwd`);
    libproc ??= openLibproc();
    const info = new Uint8Array(vnodePathInfoSize);
    if (libproc.symbols.proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, ptr(info), info.length) !== info.length) return undefined;
    const path = info.subarray(vnodeInfoSize, vnodeInfoSize + maxPathLength);
    const end = path.indexOf(0);
    const cwd = new TextDecoder().decode(end < 0 ? path : path.subarray(0, end));
    return cwd === "" ? undefined : cwd;
  } catch {
    return undefined;
  }
}
