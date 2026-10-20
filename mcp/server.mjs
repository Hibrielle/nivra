import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import {
  RULE_GUIDE,
  RULE_PACK_SCHEMA,
  RULE_TEMPLATES,
  makeRulePack,
  parseRulePack,
  planImport,
} from '../rules.js';

import { evaluateNode } from './evaluator.mjs';
import { validateArchiveRoot } from '../engine.js';

const textField = (max, description) => z.string().max(max).optional().describe(description);
const ruleSchema = z
  .object({
    name: z.string().min(1).max(60).describe('Human-readable rule name'),
    enabled: z.boolean().optional().describe('Defaults to true'),
    extensions: textField(
      1000,
      'Comma-separated extensions without leading dots, e.g. pdf, docx. At least one match condition must be nonempty.',
    ),
    domain: textField(
      253,
      'Exact hostname or its subdomains, without scheme/path. Checked against download URL, final URL and referrer.',
    ),
    keyword: textField(512, 'Case-insensitive substring of the filename'),
    regex: textField(2048, 'Full JavaScript filename regex; execution has a time limit'),
    mime: textField(2048, 'MIME regex'),
    urlRegex: textField(2048, 'Original URL regex'),
    finalUrlRegex: textField(2048, 'Final URL regex'),
    referrerRegex: textField(2048, 'Referrer regex'),
    tabUrlRegex: textField(2048, 'Active tab URL regex'),
    regexFlags: textField(4, 'i/m/s/u flags, default i'),
    filenameTemplate: textField(1024, 'Filename template; default {filename}'),
    pathTemplate: textField(
      1024,
      'Full relative path template, overrides folder and filename; accepts RegExp captures ${url:1} and dates',
    ),
    condition: textField(4096, 'Chrono style expression, e.g. *ext*.is("pdf")'),
    reference: textField(60, 'Internal name for rule references'),
    asFilter: z.boolean().optional(),
    action: z.enum(['archive', 'keep']).optional(),
    conflictAction: z.enum(['uniquify', 'overwrite', 'prompt']).optional(),
    postAction: z.enum(['none', 'reveal']).optional(),
    folder: textField(
      1024,
      'Relative folder under the local archive root; supports dates, host and captures. Empty means archive root; no absolute paths or traversal',
    ),
  })
  .strict();
const packSchema = z
  .object({
    format: z.literal('nivra-rules'),
    version: z.literal(1),
    rules: z.array(ruleSchema).max(100),
  })
  .strict();
const sampleSchema = z
  .object({
    mime: textField(255, 'MIME type'),
    tabUrl: textField(4096, 'Active tab URL'),
    pageTitle: textField(4096, 'Source page title if known'),
    linkText: textField(4096, 'Link text'),
    totalBytes: z.number().optional(),
    filename: z.string().min(1).max(255),
    url: textField(4096, 'Download URL'),
    finalUrl: textField(4096, 'Final URL after redirects'),
    referrer: textField(4096, 'Referrer page when provided by the browser'),
    startTime: textField(
      40,
      'ISO download start timestamp; defaults to now, using the local timezone for folder dates',
    ),
  })
  .strict();

const { version } = JSON.parse(
  await readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
);
const server = new McpServer({ name: 'nivra-config', version });
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const reply = (value) => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});
const guarded = (handler) => async (args) => {
  try {
    return reply(await handler(args));
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message }] };
  }
};

server.registerTool(
  'nivra_guide',
  {
    title: 'Nivra configuration guide',
    description:
      'Get the exact rule format, supported conditions, examples and templates before generating Nivra configuration. This server prepares configuration only; it cannot read or modify the live browser.',
    inputSchema: z.object({}),
    annotations,
  },
  guarded(() => ({
    guide: RULE_GUIDE,
    schema: RULE_PACK_SCHEMA,
    templates: RULE_TEMPLATES,
    application:
      'Return a JSON rule pack to the user. In the extension choose 归档规则 → 导入 / AI 配置 → 校验并预览 → 应用导入. Never claim the rules are already applied.',
  })),
);

server.registerTool(
  'nivra_validate',
  {
    title: 'Validate a rule pack',
    description:
      'Validate the same paths, conditions and regex constraints used by the browser extension. Optionally compare with an exported existing pack to preview duplicate skipping and rule order. Does not apply changes.',
    inputSchema: z.object({
      pack: packSchema,
      existingPack: packSchema.optional(),
      position: z.enum(['first', 'last']).default('first'),
    }),
    annotations,
  },
  guarded(({ pack, existingPack, position }) => {
    const normalized = parseRulePack(pack);
    const plan = planImport(
      normalized,
      existingPack ? parseRulePack(existingPack).rules : [],
      position,
    );
    return {
      valid: true,
      pack: normalized,
      preview: { added: plan.added.length, skipped: plan.skipped, total: plan.total, position },
      applied: false,
    };
  }),
);

server.registerTool(
  'nivra_simulate',
  {
    title: 'Simulate rule matching',
    description:
      'Dry-run representative filenames and source URLs. Uses the extension engine; first enabled match wins and conditions are ANDed. Returns target paths and optional explanations of priority conflicts. Never downloads, scans, or moves files.',
    inputSchema: z.object({
      pack: packSchema,
      samples: z.array(sampleSchema).min(1).max(20),
      enabled: z.boolean().default(true),
      includeTrace: z.boolean().default(false),
      matchMode: z.enum(['first', 'last']).default('first'),
      archiveRoot: z
        .string()
        .max(256)
        .default('')
        .describe(
          'Local archive subfolder from extension settings. Prepended once to matched paths; not included in rule packs and never an absolute OS directory.',
        ),
    }),
    annotations: { ...annotations, idempotentHint: false },
  },
  guarded(async ({ pack, samples, enabled, includeTrace, matchMode, archiveRoot }) => {
    archiveRoot = validateArchiveRoot(archiveRoot);
    const rules = parseRulePack(pack).rules.map((rule, index) => ({
      ...rule,
      id: `rule-${index + 1}`,
    }));
    const results = await evaluateNode('simulate', {
      samples,
      config: { enabled, rules, matchMode, archiveRoot },
    });
    return {
      applied: false,
      results: results.map((result) => ({
        filename: result.filename,
        decision: result.decision,
        ...(includeTrace
          ? { steps: result.steps }
          : {
              alsoMatched: result.steps.filter((s) => s.status === 'shadowed').map((s) => s.name),
            }),
      })),
    };
  }),
);

server.registerTool(
  'nivra_create_pack',
  {
    title: 'Create an importable rule pack',
    description:
      'Normalize and validate proposed rules and return the exact JSON text to import into Nivra. Configuration is returned to the AI client; no file or browser settings are written.',
    inputSchema: z.object({ rules: z.array(ruleSchema).min(1).max(100) }),
    annotations,
  },
  guarded(({ rules }) => {
    const pack = makeRulePack(rules);
    return {
      pack,
      json: JSON.stringify(pack, null, 2),
      applied: false,
      nextAction: 'Paste json into the extension’s rule import dialog, preview, then apply.',
    };
  }),
);

await server.connect(new StdioServerTransport());
