import { z } from 'zod';

const option = z
  .object({
    label: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((value) => value !== 'Other...'),
    description: z.string().max(200).optional(),
    recommended: z.boolean().optional(),
  })
  .strict();
const question = z
  .object({
    header: z.string().trim().min(1).max(50),
    question: z.string().trim().min(1).max(200),
    multiSelect: z.boolean().default(false),
    allowFreeformInput: z.boolean().default(true),
    options: z.array(option).min(1).max(8).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.options || value.allowFreeformInput),
    'Choices or freeform input are required.',
  )
  .refine(
    (value) =>
      !value.options ||
      new Set(value.options.map((item) => item.label)).size === value.options.length,
    'Choice labels must be unique.',
  );

export const questionRequest = z
  .object({
    questions: z.array(question).min(1).max(4),
  })
  .strict()
  .refine(
    (value) => new Set(value.questions.map((item) => item.header)).size === value.questions.length,
    'Question headers must be unique.',
  );
export type QuestionRequest = z.infer<typeof questionRequest>;
