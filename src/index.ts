import dotenv from 'dotenv';
dotenv.config();

import { startBot } from './bot';

console.log('─────────────────────────────');
console.log('  MTProxy Telegram Bot');
console.log('─────────────────────────────');

startBot();
