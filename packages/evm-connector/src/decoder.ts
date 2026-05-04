import type { DecodedTransaction } from "./interfaces.js";

const ERC20_APPROVE_SELECTOR = "0x095ea7b3";
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";
const UINT256_MAX = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

export function decodeTransaction(to: string, data?: string, value?: string): DecodedTransaction {
  const selector = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : null;

  let functionName: string | null = null;
  let isApproval = false;
  let approvalAmount: string | null = null;
  let spender: string | null = null;
  let token: string | null = null;

  if (selector === ERC20_APPROVE_SELECTOR && data && data.length >= 138) {
    functionName = "approve";
    isApproval = true;
    token = to;
    spender = `0x${data.slice(34, 74)}`;
    approvalAmount = `0x${data.slice(74, 138)}`;
  } else if (selector === ERC20_TRANSFER_SELECTOR) {
    functionName = "transfer";
  }

  return {
    to,
    value: value ?? "0",
    functionSelector: selector,
    functionName,
    isApproval,
    approvalAmount,
    spender,
    token,
  };
}

export function isUnlimitedApproval(decoded: DecodedTransaction): boolean {
  if (!decoded.isApproval || !decoded.approvalAmount) return false;
  return decoded.approvalAmount.toLowerCase() === UINT256_MAX;
}
