import { CredentialsSignin } from "next-auth"
import type { CredentialErrorCode } from "./auth-errors"

// Auth.js exposes only this allowlisted code to the client, never an exception message.
export class CredentialsError extends CredentialsSignin {
  constructor(public code: CredentialErrorCode) {
    super(code)
  }
}
