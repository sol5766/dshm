#!/usr/bin/env python3
"""就地给 tar.gz / .apk 归档里的 ELF 打自签名（报告 4 ③，2026-09-26）。

【为什么需要它，而不是解包→签名→重打包】
归档里有**符号链接**条目（python/bin/python → python3.12、git-core 里 180+ 个
指向 git 本体的链接）。Windows 上：
  · bsdtar 无符号链接特权 ⇒ 每条 symlink 报 Invalid argument 且**条目丢失**，
    这样重打包会把归档永久改坏；
  · 7z / Node 的展开会把 symlink **物化**成副本 ⇒ git-core 从 8MB 变 1.3GB
    （本仓库文件头注释里记着这个坑）。
Python 的 `tarfile` 能**逐条目读出来再原样写回去**：symlink 仍是 symlink 条目
（不落盘、不需特权），普通文件才落盘签名。这是唯一既保结构又能改字节的做法。

【为什么只签"看起来像 ELF"的普通文件】
端侧 execve 只拒第三方 ELF；脚本/文本/目录/symlink 都不需要签。判据取魔数
\\x7fELF（与 hostcore/app/main.js 的 isElf 同一判据），不做任何"按扩展名猜"。

【用法】python3 sign-tar-elf.py <binary-sign-tool.jar> <java> <归档路径> [<归档路径>…]
【输出】每个归档一行 `resign: <name> signed <n>/<m> ELF`；无 ELF 可签时如实说明。
【失败】任何单文件签名失败都打印并继续（不半途毁归档）；归档重写用临时文件 +
os.replace，替换是原子的。
"""
import os
import subprocess
import sys
import tarfile
import tempfile

ELF_MAGIC = b"\x7fELF"


def is_elf(path):
    try:
        with open(path, "rb") as fh:
            return fh.read(4) == ELF_MAGIC
    except OSError:
        return False


def sign_one(java, jar, src, dst):
    """调 binary-sign-tool 自签一个文件。成功返回 True。"""
    proc = subprocess.run(
        [java, "-jar", jar, "sign", "-mode", "localSign", "-selfSign", "1",
         "-inFile", src, "-outFile", dst, "-signAlg", "SHA256withECDSA"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    if proc.returncode != 0 or not os.path.exists(dst) or os.path.getsize(dst) == 0:
        tail = (proc.stderr or proc.stdout or b"").decode("utf-8", "replace").strip()
        print("  sign failed: %s :: %s" % (os.path.basename(src), tail[-160:]), file=sys.stderr)
        return False
    return True


def resign_archive(java, jar, archive, workdir):
    """重写一个归档：成员逐个处理，只对 ELF 普通文件签名。"""
    signed = 0
    total = 0
    tmp_out = archive + ".resigned"
    with tarfile.open(archive, "r:*") as tin, tarfile.open(tmp_out, "w:gz") as tout:
        for member in tin:
            # 只处理"普通文件"；symlink / 目录 / 硬链接原样搬运（不落盘）。
            if not member.isfile():
                tout.addfile(member, tin.extractfile(member) if member.isreg() else None)
                continue
            src = tin.extractfile(member)
            if src is None:
                tout.addfile(member)
                continue
            data = src.read()
            if not data.startswith(ELF_MAGIC):
                # 非 ELF：字节原样写回（保持 mode/mtime 等元数据）
                import io
                member.size = len(data)
                tout.addfile(member, io.BytesIO(data))
                continue
            total += 1
            # 落盘 → 签名 → 读回 → 按新大小写回条目（保持原 mode）
            local = os.path.join(workdir, "payload")
            with open(local, "wb") as fh:
                fh.write(data)
            out_signed = local + ".signed"
            if sign_one(java, jar, local, out_signed):
                with open(out_signed, "rb") as fh:
                    new_data = fh.read()
                member.size = len(new_data)
                import io
                tout.addfile(member, io.BytesIO(new_data))
                signed += 1
            else:
                import io
                member.size = len(data)
                tout.addfile(member, io.BytesIO(data))
    os.replace(tmp_out, archive)
    print("resign: %s signed %d/%d ELF" % (os.path.basename(archive), signed, total))
    return signed, total


def main():
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    jar, java = sys.argv[1], sys.argv[2]
    archives = sys.argv[3:]
    total_signed = 0
    with tempfile.TemporaryDirectory(prefix="dshm-sign-") as workdir:
        for archive in archives:
            if not os.path.exists(archive):
                print("resign: 归档不存在，跳过：%s" % archive, file=sys.stderr)
                continue
            s, _ = resign_archive(java, jar, archive, workdir)
            total_signed += s
    return 0 if total_signed >= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
