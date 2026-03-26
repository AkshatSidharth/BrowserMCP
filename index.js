'use strict';

/**
 * Browser MCP — Voice-Controlled Browser Automation Agent
 *
 * Execution flow:
 *   1. Capture voice (or typed text in --demo mode)
 *   2. Transcribe via OpenAI Whisper
 *   3. Parse intent via GPT → structured JSON
 *   4. Validate against safety whitelist
 *   5. Confirm if destructive
 *   6. Execute via Playwright on your existing Chrome session
 *   7. Print result
 */

require('dotenv').config();
const chalk = require('chalk');
const logger = require('./logger');
const { getActivePage, disconnect } = require('./browser/connect');
const { recordAndTranscribe, getTextInput } = require('./voice/listen');
const { parseIntent } = require('./brain/intentParser');
const { validateAction, confirmDestructive } = require('./safety/guard');
const { executeAction } = require('./actions');

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DEMO_MODE  = args.includes('--demo');   // Type commands instead of speaking
const DEBUG_MODE = args.includes('--debug');
if (DEBUG_MODE) process.env.LOG_LEVEL = 'debug';

// ─── Banner ───────────────────────────────────────────────────────────────────
function printBanner() {
  console.log(chalk.cyan.bold('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.cyan.bold('║        Browser MCP — Voice CRM Agent     ║'));
  console.log(chalk.cyan.bold('╚══════════════════════════════════════════╝'));
  if (DEMO_MODE) {
    console.log(chalk.yellow('  Mode: DEMO (text input — no microphone)\n'));
  } else {
    console.log(chalk.green(`  Mode: VOICE (Whisper, ${process.env.VOICE_RECORD_SECONDS || 5}s per command)\n`));
  }
  console.log(chalk.gray('  Type "exit" or press Ctrl+C to quit.\n'));
  console.log(chalk.gray('  Example commands:'));
  console.log(chalk.gray('    "Open YouTube"'));
  console.log(chalk.gray('    "Search Google for Playwright docs"'));
  console.log(chalk.gray('    "Create a lead named Rahul phone 9876543210"'));
  console.log(chalk.gray('    "Get tickets"\n'));
}

// ─── Single command cycle ─────────────────────────────────────────────────────
async function runOnce(page) {
  // 1. Get user input
  let text;
  if (DEMO_MODE) {
    text = await getTextInput(chalk.green('🎤  Command> '));
  } else {
    console.log(chalk.green('\n🎤  Listening ... (speak now)'));
    text = await recordAndTranscribe();
  }

  if (!text) return;
  if (text.toLowerCase() === 'exit') return 'exit';

  // 2. Parse intent
  let intent;
  try {
    intent = await parseIntent(text);
  } catch (err) {
    logger.error(`Intent parsing failed: ${err.message}`);
    return;
  }

  // 3. Safety validation
  const { ok, reason } = validateAction(intent);
  if (!ok) {
    console.log(chalk.red(`\n✗ Blocked: ${reason}`));
    logger.warn(`Blocked action: ${JSON.stringify(intent)}`);
    return;
  }

  // 4. Confirm destructive actions
  const confirmed = await confirmDestructive(intent);
  if (!confirmed) return;

  // 5. Execute
  console.log(chalk.blue(`\n⚡ Executing: ${chalk.bold(intent.action)}  ${JSON.stringify(intent.params)}`));
  try {
    const result = await executeAction(intent.action, page, intent.params);
    if (result.success) {
      console.log(chalk.green(`\n✓ ${result.message}`));
    } else {
      console.log(chalk.yellow(`\n⚠ ${result.message}`));
    }

    // Audit log every executed action
    logger.info('Action executed', {
      action: intent.action,
      params: intent.params,
      success: result.success,
      message: result.message,
    });
  } catch (err) {
    console.log(chalk.red(`\n✗ Error: ${err.message}`));
    logger.error(`Action "${intent.action}" failed: ${err.message}`, { stack: err.stack });
  }
}

// ─── Main loop ────────────────────────────────────────────────────────────────
async function main() {
  printBanner();

  // Validate required env vars
  if (!process.env.OPENAI_API_KEY) {
    console.error(chalk.red('ERROR: OPENAI_API_KEY is not set. Copy .env.example → .env and add your key.'));
    process.exit(1);
  }

  // Connect to Chrome (will throw if Chrome isn't running with --remote-debugging-port)
  let page;
  try {
    page = await getActivePage();
    console.log(chalk.green(`Connected to Chrome. Active tab: ${page.url()}\n`));
  } catch (err) {
    console.error(chalk.red(`\nFailed to connect to Chrome:\n  ${err.message}`));
    console.error(chalk.yellow(
      '\nMake sure Chrome is running with:\n' +
      `  chrome --remote-debugging-port=${process.env.CHROME_DEBUG_PORT || 9222} --user-data-dir="./chrome-profile"\n`
    ));
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log(chalk.cyan('\n\nShutting down ...'));
    await disconnect();
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  // Command loop
  while (true) {
    const result = await runOnce(page);
    if (result === 'exit') {
      await shutdown();
      break;
    }
    // Refresh page reference in case tab changed
    try {
      page = await getActivePage();
    } catch { /* use existing page */ }
  }
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
