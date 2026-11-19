#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(root, 'hostruntime/src/main/cpp/dshhost.cc'), 'utf8');
function problems(s) {
  const out = [];
  if (!s.includes('O_WRONLY | O_APPEND | O_CLOEXEC')) out.push('输出 fd 必须 O_APPEND，截断后不可按旧 offset 写出大洞');
  if (!s.includes('::fstat(fd, &st)') || !s.includes('::ftruncate(fd, 0)')) out.push('容量治理必须针对持有的同一 fd');
  if (!s.includes('LimitNodeOutput(fd)') || !s.includes('milliseconds(kNodeOutputCheckMs)')) out.push('缺少运行期容量检查');
  if (!s.includes('if (g_outputFd >= 0) return true;')) out.push('进程内只能启动一份捕获与监控');
  if (/TailNodeOutput|DSHM-NODELIVE|DSHM-NODEOUT|::freopen/.test(s)) out.push('禁止恢复全量 hilog 回灌或非追加重定向');
  if (!s.includes('AppendLifecycle(homeDir,') || !s.includes('::write(g_crashFd,')) out.push('必须保留独立退出与崩溃留痕');
  return out;
}
assert.deepEqual(problems(source), []);
console.log('原生输出契约通过：追加写、同 fd 治理、单监控、无全量回灌、独立崩溃/退出留痕');

const nativeRoot = '/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/sdk/default/openharmony/native';
const cxx = process.env.CXX || (existsSync(join(nativeRoot, 'llvm/bin/clang++')) ? join(nativeRoot, 'llvm/bin/clang++') : 'c++');
const flags = cxx.startsWith(nativeRoot) ? [`--sysroot=${nativeRoot}/sysroot`, '--target=aarch64-linux-ohos'] : [];
const dir = mkdtempSync(join(tmpdir(), 'dshm-node-output-'));
try {
  const start = source.indexOf('constexpr off_t kNodeOutputLimit');
  const end = source.indexOf('static bool CaptureNodeOutput', start);
  assert(start >= 0 && end > start, '缺少容量治理实现边界');
  const implementation = source.slice(start, end);
  const harness = `
#include <atomic>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
${implementation}
int main(int argc, char** argv) {
  std::string path = std::string(argv[1]) + "/output.log";
  int fd = ::open(path.c_str(), O_CREAT | O_RDWR | O_APPEND, 0600);
  assert(fd >= 0);
  int duplicate = ::dup(fd);
  struct stat before {}, after {};
  assert(::fstat(fd, &before) == 0);
  assert(::ftruncate(fd, kNodeOutputLimit + 4096) == 0);
  assert(::lseek(fd, kNodeOutputLimit + 4096, SEEK_SET) >= 0);
  assert(LimitNodeOutput(fd));
  const char error[] = "FATAL: keep-new-error\\n";
  assert(::write(duplicate, error, sizeof(error)-1) == sizeof(error)-1);
  assert(::fstat(fd, &after) == 0);
  assert(before.st_ino == after.st_ino);
  assert(after.st_size < 4096);
  char bytes[4096] {};
  assert(::pread(fd, bytes, sizeof(bytes)-1, 0) == after.st_size);
  assert(std::strstr(bytes, error));
  assert(std::strlen(bytes) == static_cast<size_t>(after.st_size));
  assert(LimitNodeOutput(fd));
  assert(::fstat(fd, &after) == 0 && after.st_size < 4096);
  // 高频重复触发后再写错误；重复描述符必须仍落在同一有界文件而不是旧 inode。
  const std::string block(65536, 'x');
  for (int i = 0; i < 320; ++i) {
    assert(::write(duplicate, block.data(), block.size()) == block.size());
    assert(LimitNodeOutput(fd));
    assert(::fstat(fd, &after) == 0 && after.st_size <= kNodeOutputLimit);
  }
  assert(::write(duplicate, error, sizeof(error)-1) == sizeof(error)-1);
  assert(::fstat(fd, &after) == 0);
  assert(::pread(fd, bytes, sizeof(error)-1, after.st_size-(sizeof(error)-1)) == sizeof(error)-1);
  assert(std::memcmp(bytes, error, sizeof(error)-1) == 0);
  std::atomic<bool> done {false};
  std::thread writer([&]() {
    for (int i = 0; i < 320; ++i) {
      assert(::write(duplicate, block.data(), block.size()) == block.size());
    }
    done.store(true);
  });
  while (!done.load()) assert(LimitNodeOutput(fd));
  writer.join();
  assert(LimitNodeOutput(fd));
  assert(::write(duplicate, error, sizeof(error)-1) == sizeof(error)-1);
  assert(::fstat(fd, &after) == 0 && after.st_size < kNodeOutputLimit + 4096);
  assert(::pread(fd, bytes, sizeof(error)-1, after.st_size-(sizeof(error)-1)) == sizeof(error)-1);
  assert(std::memcmp(bytes, error, sizeof(error)-1) == 0);
  ::close(duplicate);
  ::close(fd);
}
`;
  const cpp = join(dir, 'bounds.cc');
  const bin = join(dir, 'bounds');
  writeFileSync(cpp, harness);
  const compiled = spawnSync(cxx, [...flags, '-std=c++17', '-pthread', cpp, '-o', bin], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, `容量治理宿主测试编译失败：${compiled.stderr || compiled.error}`);
  function executable() {
    if (!['ohos', 'openharmony'].includes(process.platform)) return bin;
    assert.equal(readFileSync(bin).subarray(0, 4).toString('hex'), '7f454c46', '只允许签名测试 ELF');
    const signer = resolve(nativeRoot, '../toolchains/lib/binary-sign-tool');
    const stripped = bin + '.unsigned';
    const objcopy = join(nativeRoot, 'llvm/bin/llvm-objcopy');
    const strip = spawnSync(objcopy, ['--remove-section=.codesign', bin, stripped], { encoding: 'utf8' });
    assert.equal(strip.status, 0, `移除临时测试 ELF 预留签名段失败：${strip.stderr || strip.error}`);
    const signed = bin + '.signed';
    if (existsSync(signed)) rmSync(signed);
    const sign = spawnSync(signer, ['sign', '-inFile', stripped, '-outFile', signed, '-selfSign', '1'], { encoding: 'utf8' });
    assert.equal(sign.status, 0, `测试 ELF 自签失败：${sign.stderr || sign.stdout || sign.error}`);
    return signed;
  }
  const run = spawnSync(executable(), [dir], { encoding: 'utf8' });
  assert.equal(run.status, 0, `容量治理宿主测试失败：${run.stderr || run.error}`);
  console.log('生产 LimitNodeOutput 宿主行为通过：同 inode、旧 offset 无洞、dup fd 续写、20 MiB 多轮治理、新错误完整');
  if (process.argv.includes('--self-test')) {
    const arms = [
      ['移除 O_APPEND', source.replace('O_WRONLY | O_APPEND | O_CLOEXEC', 'O_WRONLY | O_CLOEXEC')],
      ['移除同 fd 截断', source.replace('::ftruncate(fd, 0)', '::ftruncate(-1, 0)')],
      ['移除运行期治理', source.replace('const bool ok = LimitNodeOutput(fd);', 'const bool ok = true;')],
      ['恢复全量回灌', source + '\n// DSHM-NODELIVE'],
      ['移除单监控守卫', source.replace('if (g_outputFd >= 0) return true;', '')]
    ];
    for (const [name, changed] of arms) {
      assert.notEqual(changed, source, `${name} 变异锚点未命中`);
      assert(problems(changed).length > 0, `${name} 未判红`);
      console.log(`变异判红：${name}`);
    }
    writeFileSync(cpp, harness.replace('O_RDWR | O_APPEND', 'O_RDWR'));
    const mutantCompile = spawnSync(cxx, [...flags, '-std=c++17', '-pthread', cpp, '-o', bin], { encoding: 'utf8' });
    assert.equal(mutantCompile.status, 0, mutantCompile.stderr);
    const mutant = spawnSync(executable(), [dir], { encoding: 'utf8' });
    assert(!mutant.error, `变异程序未执行：${mutant.error}`);
    assert.notEqual(mutant.status, 0, '移除 O_APPEND 的真实文件行为变异必须因大洞而失败');
    console.log('真实行为变异判红：移除 O_APPEND 后旧 offset 产生大洞');
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
