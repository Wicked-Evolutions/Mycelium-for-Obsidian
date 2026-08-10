import { validateRequiredLiveEnvironment } from './support.mjs';

try {
  validateRequiredLiveEnvironment();
  console.log('Live release gate preflight: required Obsidian and Ollama lanes enabled.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Live release gate NOT RUN: invalid environment.');
  process.exitCode = 1;
}
