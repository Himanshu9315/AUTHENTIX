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

// Events emitted by booking-service. Mirrors contracts/order.*.schema.json.
export const orderConfirmedSchema = z
  .object({
    orderId: z.string().uuid(),
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    items: z
      .array(
        z.object({
          tierId: z.string().uuid(),
          seatId: z.string().uuid().nullable(),
          seatLabel: z.string().nullable(),
          quantity: z.number().int().min(1),
          unitPriceInr: z.number().int().min(0),
        }).strict(),
      )
      .min(1),
    totalInr: z.number().int().min(0),
    confirmedAt: z.string().datetime(),
  })
  .strict();

export const orderRefundedSchema = z
  .object({
    orderId: z.string().uuid(),
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    reason: z.enum(["seats_unavailable", "sold_out", "late_payment"]),
    refundedAt: z.string().datetime(),
  })
  .strict();

// Events emitted by ticket-service. Mirrors contracts/ticket.*.schema.json.
export const ticketIssuedSchema = z
  .object({
    orderId: z.string().uuid(),
    userId: z.string().uuid(),
    eventId: z.string().uuid(),
    ticketIds: z.array(z.string().uuid()).min(1),
    issuedAt: z.string().datetime(),
  })
  .strict();

export const ticketTransferredSchema = z
  .object({
    transferId: z.string().uuid(),
    ticketId: z.string().uuid(),
    eventId: z.string().uuid(),
    fromUserId: z.string().uuid(),
    toUserId: z.string().uuid(),
    newVersion: z.number().int().min(2),
    transferredAt: z.string().datetime(),
  })
  .strict();

/** Why a gate scan was rejected. A closed list, so the scanner can show a clear message for each. */
export const SCAN_REASONS = /** @type {const} */ (["invalid_qr", "qr_expired", "scan_stale", "wrong_event", "already_used", "ticket_replaced", "ticket_void", "event_not_open"]);
export const scanReasonSchema = z.enum(SCAN_REASONS);

export const scanRequestSchema = z.object({
  scanId: z.string().uuid(),
  eventId: z.string().uuid(),
  gateId: z.string().min(1).max(32),
  token: z.string().min(1).max(100),
  scannedAt: z.string().datetime(),
});

export const transferRequestSchema = z.object({ recipientEmail: emailSchema });

// Events from auth-service and aadhaar-service that notification-service consumes. Mirrors contracts/user.*.schema.json.
export const userEmailVerificationRequestedSchema = z
  .object({ userId: z.string().uuid(), email: emailSchema, name: z.string().min(1).max(100), token: z.string().min(20).max(200) })
  .strict();
export const userEmailVerifiedSchema = z.object({ userId: z.string().uuid() }).strict();
export const userVerifiedSchema = z.object({ userId: z.string().uuid(), verifiedAt: z.string().datetime() }).strict();
