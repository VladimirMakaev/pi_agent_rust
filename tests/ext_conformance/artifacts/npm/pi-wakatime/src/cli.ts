import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as child_process from 'node:child_process';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import AdmZip from 'adm-zip';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/wakatime/wakatime-cli/releases/latest';
const GITHUB_DOWNLOAD_URL = 'https://github.com/wakatime/wakatime-cli/releases/latest/download';

export class WakaTimeCli {
  private cliLocation: string | undefined;
  private installDir: string;

  constructor() {
    this.installDir = path.join(os.homedir(), '.wakatime');
    if (!fs.existsSync(this.installDir)) {
      fs.mkdirSync(this.installDir, { recursive: true });
    }
  }

  public getLocation(): string {
    if (this.cliLocation) return this.cliLocation;

    // Check global
    try {
      const cmd = process.platform === 'win32' ? 'where' : 'which';
      const binary = `wakatime-cli${process.platform === 'win32' ? '.exe' : ''}`;
      const globalPath = child_process.execSync(`${cmd} ${binary}`).toString().split('\n')[0].trim();
      if (globalPath && fs.existsSync(globalPath)) {
        this.cliLocation = globalPath;
        return globalPath;
      }
    } catch (e) {
      // Ignore
    }

    // Check local
    const ext = process.platform === 'win32' ? '.exe' : '';
    const osName = this.getOsName();
    const arch = this.getArchitecture();
    const binaryName = `wakatime-cli-${osName}-${arch}${ext}`;
    const localPath = path.join(this.installDir, binaryName);

    // Also check standard name in install dir (renamed after download)
    const standardPath = path.join(this.installDir, `wakatime-cli${ext}`);

    if (fs.existsSync(standardPath)) {
      this.cliLocation = standardPath;
      return standardPath;
    }

    if (fs.existsSync(localPath)) {
      this.cliLocation = localPath;
      return localPath;
    }

    // Default to standard path for future installation
    return standardPath;
  }

  public async checkAndInstall(): Promise<string> {
    const location = this.getLocation();
    if (fs.existsSync(location)) {
      return location;
    }

    console.log('[WakaTime] Installing wakatime-cli...');
    await this.install();
    return this.getLocation();
  }

  private async install(): Promise<void> {
    const osName = this.getOsName();
    const arch = this.getArchitecture();
    const url = `${GITHUB_DOWNLOAD_URL}/wakatime-cli-${osName}-${arch}.zip`;
    const zipPath = path.join(this.installDir, `wakatime-cli-temp.zip`);

    await this.downloadFile(url, zipPath);

    console.log('[WakaTime] Extracting...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(this.installDir, true);
    
    fs.unlinkSync(zipPath);

    // Find extracted file and rename/link
    const ext = process.platform === 'win32' ? '.exe' : '';
    const extractedName = `wakatime-cli-${osName}-${arch}${ext}`;
    const extractedPath = path.join(this.installDir, extractedName);
    const targetPath = path.join(this.installDir, `wakatime-cli${ext}`);

    if (fs.existsSync(extractedPath)) {
        // If the zip contained the long name
        fs.renameSync(extractedPath, targetPath);
    } 
    
    if (process.platform !== 'win32') {
        fs.chmodSync(targetPath, 0o755);
    }
    
    this.cliLocation = targetPath;
    console.log(`[WakaTime] Installed to ${targetPath}`);
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download ${url}: ${res.statusText}`);
    const stream = fs.createWriteStream(dest);
    // @ts-ignore
    await finished(Readable.fromWeb(res.body).pipe(stream));
  }

  private getOsName(): string {
    if (process.platform === 'win32') return 'windows';
    return process.platform;
  }

  private getArchitecture(): string {
    const arch = os.arch();
    if (arch.indexOf('32') > -1) return '386';
    if (arch.indexOf('x64') > -1) return 'amd64';
    return arch;
  }
}
