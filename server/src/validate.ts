import { z } from "zod";

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "id 只允许字母数字下划线连字符");
const authorSchema = z.string().min(1).max(64);
const baseVersionSchema = z.number().int().positive();

export const itemSchema = z.object({
  id: z.string().min(1).max(128),
  text: z.string().max(10_000),
  done: z.boolean(),
  urgent: z.boolean(),
  time: z.string().max(64).nullable(),
});

export const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  monitor: z.number().int(),
});

const common = {
  title: z.string().max(500).nullable(),
  color: z.string().max(32).nullable(),
  position: positionSchema.nullable(),
};

/** 内容按 body_type 判别（协议 §3.1）：所有字段必填，缺省用 null */
export const contentSchema = z.discriminatedUnion("body_type", [
  z
    .object({
      ...common,
      body_type: z.literal("text"),
      body: z.string().max(100_000),
      items: z.null(),
    })
    .strict(),
  z
    .object({
      ...common,
      body_type: z.literal("checklist"),
      body: z.null(),
      items: z.array(itemSchema).max(500),
    })
    .strict(),
]);

export const createRequestSchema = z
  .object({
    id: idSchema.optional(),
    author: authorSchema,
    base_version: z.null().optional(),
    content: contentSchema,
  })
  .strict();

export const updateRequestSchema = z
  .object({
    author: authorSchema,
    base_version: baseVersionSchema,
    content: contentSchema,
  })
  .strict();

export const deleteRequestSchema = z
  .object({
    author: authorSchema,
    base_version: baseVersionSchema,
  })
  .strict();

export const restoreRequestSchema = z
  .object({
    author: authorSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const syncQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

/** 把 zod 校验错误压成人类可读的 details（HTTP 400 用） */
export function flattenIssues(e: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    out[key] = issue.message;
  }
  return out;
}
