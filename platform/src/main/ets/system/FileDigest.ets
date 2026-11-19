import { fileIo as fs } from '@kit.CoreFileKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';

/** Shared streaming digest; callers handle IO/crypto failures.
 * @throws Error when file IO or crypto cannot complete.
 */
export async function sha256OfFile(path: string): Promise<string> {
  const md: cryptoFramework.Md = cryptoFramework.createMd('SHA256');
  const file: fs.File = fs.openSync(path, fs.OpenMode.READ_ONLY);
  let failed: boolean = false;
  try {
    const size: number = 256 * 1024;
    const buffer: ArrayBuffer = new ArrayBuffer(size);
    while (true) {
      const n: number = fs.readSync(file.fd, buffer, { length: size });
      if (n <= 0) { break; }
      const piece: cryptoFramework.DataBlob = { data: new Uint8Array(buffer.slice(0, n)) };
      await md.update(piece);
    }
    const digest: cryptoFramework.DataBlob = await md.digest();
    let hex: string = '';
    for (let i: number = 0; i < digest.data.length; i++) {
      hex += digest.data[i].toString(16).padStart(2, '0');
    }
    return hex;
  } catch (error) {
    failed = true;
    throw error as Error;
  } finally {
    try {
      fs.closeSync(file);
    } catch (closeError) {
      if (!failed) { throw closeError as Error; }
    }
  }
}
