import { defineConfig } from '@playwright/test';
export default defineConfig({use:{channel:process.env.CI ? undefined : 'chrome'},workers:1});
