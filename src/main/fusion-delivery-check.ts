export interface DeliveryMessage {
 role: string;
 model?: string;
 stopReason?: string;
 content?: unknown;
}
/** Structural delivery checks are separate from externally executed functional checks.
 * They prove a Lead review happened, not that the review's conclusions are correct. */
export function fusionDeliveryChecks(messages: DeliveryMessage[], leadModel: string, fusion: boolean) {
 const parts = (message: DeliveryMessage): { type: string; name?: string; text?: string }[] =>
  Array.isArray(message.content) ? message.content : [];
 const reversed = [...messages].reverse();
 const reverseReviewIndex = fusion ? reversed.findIndex(message => message.role === "toolResult" &&
  (message as DeliveryMessage & { toolName?: string; isError?: boolean }).toolName === "fusion_review" &&
  !(message as DeliveryMessage & { isError?: boolean }).isError) : -1;
 const reviewIndex = reverseReviewIndex < 0 ? -1 : messages.length - 1 - reverseReviewIndex;
 const reverseImplementationIndex = reversed.findIndex(message => message.role === "toolResult" &&
  (message as DeliveryMessage & { toolName?: string; isError?: boolean }).toolName === "fusion_implement" &&
  !(message as DeliveryMessage & { isError?: boolean }).isError);
 const implementationReturned = reverseImplementationIndex >= 0 && reverseReviewIndex >= 0 && reverseReviewIndex < reverseImplementationIndex;
 const leadRead = messages.slice(reviewIndex + 1).some(message => message.role === "assistant" &&
  message.model === leadModel && parts(message).some(part => part.type === "toolCall" && part.name === "read"));
 const final = reversed.find(message => message.role === "assistant");
 return {
  reportReturned: !fusion || implementationReturned,
  leadReviewedSource: leadRead,
  leadFinalAnswer: !!final && final.model === leadModel && final.stopReason === "stop" &&
   parts(final).some(part => part.type === "text" && !!part.text?.trim()) &&
   !parts(final).some(part => part.type === "toolCall"),
 };
}

/** Extra requests are reserved exclusively for Lead acceptance, not more Sidekick work. */
export function canRequestForDelivery(requests: number, model: string, leadModel: string, fusion: boolean, workLimit: number, reserve = 6, accepting = true): boolean {
 return requests < workLimit || (fusion && accepting && model === leadModel && requests < workLimit + reserve);
}
