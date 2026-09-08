"use client";

let confirmLeaveMessage: string | null = null;

export function setConfirmLeaveMessage(message: string | null) {
  confirmLeaveMessage = message;
}

export function getConfirmLeaveMessage() {
  return confirmLeaveMessage;
}

export function confirmLeaveIfNeeded() {
  if (!confirmLeaveMessage) return true;
  return window.confirm(confirmLeaveMessage);
}
