import type { SignupMode } from "../../shared/types";
import { getSetting } from "./settings";

/** Instance setting "Sign-up": absent = off (invitations only), "apply" = Request access (/apply), "open" = public sign-up. */
export const SIGNUP_MODE_SETTING = "signup_mode";

export const isSignupMode = (v: unknown): v is SignupMode => v === "off" || v === "apply" || v === "open";

export async function signupMode(db: D1Database): Promise<SignupMode> {
  const v = await getSetting(db, SIGNUP_MODE_SETTING);
  return v === "apply" || v === "open" ? v : "off";
}
