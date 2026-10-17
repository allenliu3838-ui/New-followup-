/**
 * Password strength validator — the single source for the rules that the
 * registration, password-reset and workbench pages display and enforce.
 *
 * Requirements:
 *   - At least 8 characters
 *   - At least 1 uppercase letter
 *   - At least 1 lowercase letter
 *   - At least 1 digit
 *   - At least 1 special character
 *
 * validatePassword() returns { valid: boolean, errors: string[], message: string }
 * (unchanged contract; staff.js depends on it).
 */
export const PASSWORD_RULES = Object.freeze([
  { id: "length", label: "至少 8 位", test: (p) => typeof p === "string" && p.length >= 8 },
  { id: "upper", label: "至少 1 个大写字母", test: (p) => /[A-Z]/.test(p || "") },
  { id: "lower", label: "至少 1 个小写字母", test: (p) => /[a-z]/.test(p || "") },
  { id: "digit", label: "至少 1 个数字", test: (p) => /[0-9]/.test(p || "") },
  { id: "special", label: "至少 1 个特殊字符（如 !@#$%）", test: (p) => /[^A-Za-z0-9]/.test(p || "") },
]);

/** One sentence describing every rule, for labels and hints. */
export function passwordRuleText() {
  return "至少 8 位，并同时包含大写字母、小写字母、数字和特殊字符（如 !@#$%）";
}

/** Per-rule status, for a live checklist under the password field. */
export function passwordChecklist(password) {
  return PASSWORD_RULES.map((rule) => ({ id: rule.id, label: rule.label, ok: rule.test(password) }));
}

export function validatePassword(password) {
  const errors = PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.label);
  return {
    valid: errors.length === 0,
    errors,
    message: errors.length ? "密码要求：" + errors.join("、") : "",
  };
}
