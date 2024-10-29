import { Context, Next } from "hono";
import { z } from "zod";
import { Validator } from "../../utils/validation";

export const emailSchema = z.object({
  from: z.string().email(),
  to: z.array(z.string().email()),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1),
  textContent: z.string().optional(),
  htmlContent: z.string().optional(),
  priority: z.enum(["high", "normal", "low"]).optional(),
});

export async function validateEmail(c: Context, next: Next) {
  try {
    const body = await c.req.json();
    const validatedData = emailSchema.parse(body);
    c.set("validatedData", validatedData);
    await next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      return c.json(
        {
          error: "Validation failed",
          details: error.errors,
        },
        400
      );
    }
    return c.json({ error: "Invalid request body" }, 400);
  }
}
