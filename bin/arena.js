#!/usr/bin/env node
'use strict';

const { main } = require('../src/cli');

main(process.argv.slice(2)).catch((err) => {
  const msg = err && err.friendly ? err.message : (err && err.stack) || String(err);
  process.stderr.write(msg + '\n');
  process.exit(err && typeof err.exitCode === 'number' ? err.exitCode : 1);
});
