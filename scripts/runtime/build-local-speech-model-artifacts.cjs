#!/usr/bin/env node
'use strict';

const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const tar = require('tar');
const { constants: zlibConstants, createZstdCompress } = require('zlib');

const projectRoot = path.resolve(__dirname, '../..');
const sourceRoot = path.join(projectRoot, 'resources', 'local-tts', 'win-x64');
const outputRoot = path.join(projectRoot, 'build-speech-models', 'speech-models', 'v1');
const models = [
  {
    id: 'kokoro-int8-multi-lang-v1_1',
    license: path.join(sourceRoot, 'KOKORO-LICENSE.txt'),
  },
  {
    id: 'sherpa-onnx-whisper-base',
    license: path.join(sourceRoot, 'sherpa-onnx-whisper-base', 'LICENSE'),
  },
  {
    id: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
    revision: 2,
    license: path.join(
      sourceRoot,
      'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09',
      'LICENSE',
    ),
  },
  {
    id: 'vits-icefall-zh-aishell3',
    license: path.join(sourceRoot, 'vits-icefall-zh-aishell3', 'LICENSE'),
    exclude: ['rule.far'],
  },
  {
    id: 'vits-piper-en_US-lessac-medium-int8',
    revision: 2,
    license: path.join(sourceRoot, 'vits-piper-en_US-lessac-medium-int8', 'LICENSE'),
  },
];

const sha256 = filePath => {
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
};

async function buildModel(model) {
  const source = path.join(sourceRoot, model.id);
  if (!fs.existsSync(source)) {
    throw new Error(`Missing model source: ${source}. Run npm run setup:local-speech-models.`);
  }
  if (!fs.existsSync(model.license)) throw new Error(`Missing model license: ${model.license}`);

  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-speech-artifact-'));
  const stagedModel = path.join(stagingRoot, model.id);
  const tarPath = path.join(stagingRoot, `${model.id}.tar`);
  const outputPath = path.join(
    outputRoot,
    `${model.id}${model.revision ? `.r${model.revision}` : ''}.tar.zst`,
  );
  try {
    fs.cpSync(source, stagedModel, { recursive: true });
    for (const relativePath of model.exclude ?? []) {
      fs.rmSync(path.join(stagedModel, relativePath), { recursive: true, force: true });
    }
    fs.copyFileSync(model.license, path.join(stagedModel, 'MODEL-LICENSE.txt'));
    tar.create(
      {
        cwd: stagingRoot,
        file: tarPath,
        follow: false,
        mtime: new Date(0),
        portable: true,
        sync: true,
      },
      [model.id],
    );
    await pipeline(
      fs.createReadStream(tarPath),
      createZstdCompress({
        params: { [zlibConstants.ZSTD_c_compressionLevel]: 10 },
      }),
      fs.createWriteStream(outputPath),
    );
    return {
      id: model.id,
      file: path.basename(outputPath),
      sha256: sha256(outputPath),
      compressedBytes: fs.statSync(outputPath).size,
    };
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function main() {
  // Fail before replacing any published artifacts if setup did not finish.
  for (const model of models) {
    const source = path.join(sourceRoot, model.id);
    if (!fs.existsSync(source) || !fs.existsSync(model.license)) {
      throw new Error(`Incomplete model source: ${source}. Run npm run setup:local-speech-models.`);
    }
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const results = [];
  for (const model of models) results.push(await buildModel(model));
  fs.writeFileSync(
    path.join(outputRoot, 'manifest.json'),
    `${JSON.stringify({ version: 1, models: results }, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ outputRoot, models: results }, null, 2));
}

main().catch(error => {
  console.error(`[build-local-speech-model-artifacts] ${error.message}`);
  process.exitCode = 1;
});
