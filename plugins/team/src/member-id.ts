import { z } from "zod";

export const memberId = z.string().uuid();
