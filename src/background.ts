import pako from 'pako';
import { namespaceTranslate } from './data/namespace-translate';
import { EHTDatabase, TagItem, TagList } from './interface';
import { BadgeLoading } from './tool/badge-loading';
import { chromeMessage } from './tool/chrome-message';
import emojiRegex from 'emoji-regex';

interface ReleaseCheckData {
  old: string;
  new: string;
  newLink: string;
}

interface DownloadStatus {
  run: boolean;
  progress: number;
  info: string;
  complete: boolean;
  error: boolean;
}

class background {

  /* 数据存储结构版本, 如果不同 系统会自动执行 storageTagData 重新构建数据*/
  DATA_STRUCTURE_VERSION = 2;

  badge = new BadgeLoading();
  lastCheck = 0;
  lastCheckData: ReleaseCheckData;
  tagList: TagList = [];
  loadLock = false;
  readonly downloadStatusDefault: DownloadStatus = {
    run: false,
    progress: 0,
    info: '',
    complete: false,
    error: false,
  };
  downloadStatus: DownloadStatus;

  constructor() {
    this.initDownloadStatus();
    if (chrome.contextMenus) this.initContextMenus();
    if (chrome.omnibox) this.initOmnibox();
    this.checkLocalData();
    chromeMessage.listener('get-tag-data', _ => this.getTagDataEvent());
    chromeMessage.listener('check-version', _ => this.checkVersion().then());
  }

  async getTagDataEvent() {
    // 重置下载状态
    this.initDownloadStatus();
    try {
      const data = await this.download();
      await this.storageTagData(data.db, data.release.html_url);
    } catch (err) {
      console.error(err);
      this.pushDownloadStatus({ run: false, error: true, info: (err && err.message) ? err.message : '更新失败' });
    }
  }

  initDownloadStatus() {
    this.downloadStatus = {
      ...this.downloadStatusDefault
    };
  }

  pushDownloadStatus(data: Partial<DownloadStatus> = {}) {
    this.downloadStatus = {
      ...this.downloadStatus,
      ...data,
    };
    chromeMessage.broadcast('downloadStatus', this.downloadStatus);
  }

  async checkVersion(): Promise<ReleaseCheckData> {
    const time = new Date().getTime();
    // 限制每分钟最多请求1次
    const { sha } = await new Promise((resolve) => chrome.storage.local.get(resolve));
    if ((time - this.lastCheck <= 1000 * 60) && this.lastCheckData) {
      return {
        new: (this.lastCheckData && this.lastCheckData.new) || '',
        newLink: (this.lastCheckData && this.lastCheckData.newLink) || '',
        old: sha,
      };
    }
    this.lastCheck = time;
    const githubDownloadUrl = 'https://api.github.com/repos/ehtagtranslation/Database/releases/latest';
    const info = await (await fetch(githubDownloadUrl)).json();

    if (!(info && info.target_commitish)) {
      return null;
    }
    this.lastCheckData = {
      old: sha,
      new: info.target_commitish,
      newLink: info.html_url,
    };
    return this.lastCheckData;
  }

  download(): Promise<{ release: any, db: EHTDatabase }> {
    return new Promise(async (resolve, reject) => {
      if (this.loadLock) {
        return false;
      }
      this.loadLock = true;
      this.badge.set('', '#4A90E2', 2);
      this.pushDownloadStatus({ run: true, info: '加载中' });
      const githubDownloadUrl = 'https://api.github.com/repos/ehtagtranslation/Database/releases/latest';
      const info = await (await fetch(githubDownloadUrl)).json();
      if (!(info && info.assets)) {
        reject(new Error('无法获取版本信息'));
        this.loadLock = false;
        return;
      }
      const asset = info.assets.find((i: any) => i.name === 'db.html.json.gz');
      const url = asset && asset.browser_download_url || '';
      if (!url) {
        reject(new Error('无法获取下载地址'));
        this.loadLock = false;
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => {
        this.loadLock = false;
        try {
          const data = JSON.parse(pako.ungzip(xhr.response, { to: 'string' })) as EHTDatabase;
          this.loadLock = false;
          resolve({ release: info, db: data });
          this.pushDownloadStatus({ info: '下载完成', progress: 100 });
          this.badge.set('100', '#4A90E2', 1);
        } catch (e) {
          reject(new Error('数据无法解析'));
          this.badge.set('Err', '#C80000');
        }
      };
      xhr.onerror = (e) => {
        this.loadLock = false;
        this.badge.set('ERR', '#C80000');
        reject(e);
      };
      xhr.onprogress = (event) => {
        if (event.lengthComputable) {
          const percent = Math.round((event.loaded / event.total) * 100);
          this.pushDownloadStatus({ info: Math.floor(percent) + '%', progress: Math.floor(percent) });
          this.badge.set(percent.toFixed(0), '#4A90E2', 1);
        }
      };
      xhr.send();
      this.pushDownloadStatus({ info: '0%', progress: 0 });
      this.badge.set('0', '#4A90E2', 1);
    });
  }

  storageTagData(tagDB: EHTDatabase, releasePageUrl: string): Promise<void> {
    return new Promise(resolve => {
      const namespaceOrder = ['female', 'language', 'misc', 'male', 'artist', 'group', 'parody', 'character', 'reclass'];
      const tagReplaceData: { [key: string]: string } = {};
      const tagList: TagList = [];
      tagDB.data.sort((a, b) => {
        return namespaceOrder.indexOf(a.namespace) - namespaceOrder.indexOf(b.namespace);
      });
      tagDB.data.forEach(space => {
        const namespace = space.namespace;
        if (namespace === 'rows') return;
        for (const key in space.data) {
          const t = space.data[key];
          let search = ``;
          if (namespace !== 'misc') {
            search += namespace + ':';
          }
          if (key.indexOf(' ') !== -1) {
            search += `"${key}$"`;
          } else {
            search += key + '$';
          }

          t.name = t.name.replace(/^<p>(.+)<\/p>$/, '$1').replace(emojiRegex(), '<span class="ehs-emoji">$&</span>');

          tagList.push({
            ...t,
            key,
            namespace,
            search,
          });

          tagReplaceData[`${namespace}:${key}`] = t.name;
          if (namespace === 'misc') {
            tagReplaceData[key] = t.name;
          }
        }
      });
      chrome.storage.local.set({
        tagDB,
        tagList,
        tagReplaceData,
        updateTime: new Date().getTime(),
        releaseLink: releasePageUrl,
        sha: tagDB.head.sha,
        dataStructureVersion: this.DATA_STRUCTURE_VERSION,
      }, () => {
        resolve();
        this.badge.set('OK', '#00C801');
        this.pushDownloadStatus({ run: true, info: '更新完成', progress: 100, complete: true });
        setTimeout(() => {
          this.badge.set('', '#4A90E2');
          this.pushDownloadStatus({ run: false, info: '更新完成', progress: 0, complete: false });
        }, 2500);
      });
      this.tagList = tagList;
    });
  }

  initContextMenus() {
    chrome.contextMenus.create(
      {
        documentUrlPatterns: ['*://exhentai.org/*', '*://e-hentai.org/*', '*://*.exhentai.org/*', '*://*.e-hentai.org/*'],
        title: '提交标签翻译',
        targetUrlPatterns: ['*://exhentai.org/tag/*', '*://e-hentai.org/tag/*', '*://*.exhentai.org/tag/*', '*://*.e-hentai.org/tag/*'],
        contexts: ['link'],
        onclick(info) {
          if (/\/tag\//.test(info.linkUrl)) {
            const s = info.linkUrl.replace('+', ' ').split('/');
            const s2 = s[s.length - 1].split(':');
            const namespace = s2.length === 1 ? 'misc' : s2[0];
            const tag = s2.length === 1 ? s2[0] : s2[1];
            const editorUrl = `https://ehtagtranslation.github.io/Editor/edit/${encodeURIComponent(namespace)}/${encodeURIComponent(tag)}`;
            chrome.tabs.create({
              url: editorUrl,
            });
          }
        }
      }, () => {
      }
    );
  }

  initOmnibox() {
    chrome.omnibox.onInputChanged.addListener(
      (text, suggest) => {
        if (this.tagList.length) {
          const data = this.tagList
            .filter((v: TagItem) => v.search.indexOf(text) !== -1 || v.name.indexOf(text) !== -1)
            .slice(0, 5)
            .map((tag: TagItem) => {
              const cnNamespace = namespaceTranslate[tag.namespace];
              let cnNameHtml = '';
              const enNameHtml = tag.search;
              if (tag.namespace !== 'misc') {
                cnNameHtml += cnNamespace + ':';
              }
              cnNameHtml += tag.name;
              return {
                content: enNameHtml,
                description: cnNameHtml,
              };
            });

          suggest(data);
        }
      });

    chrome.omnibox.onInputEntered.addListener(
      function (text) {
        chrome.tabs.create({
          url: `https://e-hentai.org/?f_search=${encodeURIComponent(text)}`,
        });
      });
  }

  loadPackedData() {
    const dbUrl = chrome.runtime.getURL('assets/tag.db');
    return fetch(dbUrl)
      .then(r => r.text())
      .then(t => JSON.parse(t))
      .then(d => this.storageTagData(d, 'https://github.com/EhTagTranslation/EhSyringe/blob/master/src/data/tag.db.json'));
  }

  checkLocalData() {
    // 如果沒有數據自動加載本地數據
    chrome.storage.local.get(async (data) => {
      if ('tagList' in data) {
        this.tagList = data.tagList;
      }
      if (!('tagList' in data && 'tagReplaceData' in data)) {
        await this.loadPackedData();
      } else if (data.dataStructureVersion !== this.DATA_STRUCTURE_VERSION) {
        console.log('数据结构变化, 重新构建数据');
        await this.loadPackedData();
      }
    });
  }

}

new background();
