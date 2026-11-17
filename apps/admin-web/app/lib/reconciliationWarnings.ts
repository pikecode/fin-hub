export function bankApprovalOverage(
  bankTotal: number,
  bankRemaining: number,
  approvalTotal: number,
  approvalRemaining: number,
) {
  const cents = (value: number) => Math.round(value * 100);
  if (
    ![bankTotal, bankRemaining, approvalTotal, approvalRemaining].every(
      Number.isFinite,
    )
  )
    return null;
  if (cents(bankRemaining) > cents(approvalRemaining)) {
    return {
      kind: "remaining" as const,
      bank: bankRemaining,
      approval: approvalRemaining,
      excess: (cents(bankRemaining) - cents(approvalRemaining)) / 100,
    };
  }
  if (cents(bankTotal) > cents(approvalTotal)) {
    return {
      kind: "total" as const,
      bank: bankTotal,
      approval: approvalTotal,
      excess: (cents(bankTotal) - cents(approvalTotal)) / 100,
    };
  }
  return null;
}
