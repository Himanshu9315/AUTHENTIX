import { z } from "zod";

export const ROLES = /** @type {const} */ (["attendee", "staff", "organiser", "admin"]);

export const roleSchema = z.enum(ROLES);
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(100),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

export const verifyEmailSchema = z.object({
  token: z.string().min(20).max(200),
});

export const aadhaarOtpRequestSchema = z.object({
  aadhaar: z.string().regex(/^\d{12}$/),
});

export const aadhaarVerifySchema = z.object({
  otp: z.string().regex(/^\d{6}$/),
});

export const CATEGORIES = /** @type {const} */ (["concerts", "festivals", "comedy"]);

export const eventsQuerySchema = z
  .object({
    city: z.string().trim().min(1).max(60).optional(),
    category: z.enum(CATEGORIES).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    hot: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lng: z.coerce.number().min(-180).max(180).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((d) => (d.lat === undefined) === (d.lng === undefined), { message: "lat and lng go together" });
