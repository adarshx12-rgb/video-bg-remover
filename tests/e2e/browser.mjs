// Shared Playwright launcher that drives the locally installed Chrome (or Edge).
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const ARGS = [...(process.env.CHROME_LOG ? ['--enable-logging=stderr', '--v=0'] : []), '--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];

function executable() {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found. Set CHROME_PATH.');
  return executablePath;
}

/** Fresh, throwaway profile (nothing cached). */
export async function launch({ headless = process.env.HEADED !== '1' } = {}) {
  return chromium.launch({ executablePath: executable(), headless, args: ARGS });
}

/**
 * Persistent profile so the Cache API (model files) survives between runs.
 * Returns an object with the same newPage()/close() shape as a Browser.
 */
export async function launchPersistent(profileDir, { headless = process.env.HEADED !== '1', acceptDownloads = true } = {}) {
  return chromium.launchPersistentContext(profileDir, { executablePath: executable(), headless, args: ARGS, acceptDownloads });
}

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173';
