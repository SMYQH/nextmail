export interface MessageListRefreshResult<T> {
  messages: T[]
  nextCursor: string | null
}

export function mergeRefreshedMessages<T extends { id: string }>(
  newMessages: T[],
  oldMessages: T[],
  firstPageCursor: string | null,
  existingCursor: string | null,
): MessageListRefreshResult<T> {
  const firstDuplicateIndex = newMessages.findIndex(newMessage =>
    oldMessages.some(oldMessage => oldMessage.id === newMessage.id)
  )

  if (firstDuplicateIndex === -1) {
    return {
      messages: newMessages,
      nextCursor: firstPageCursor,
    }
  }

  return {
    messages: [...newMessages.slice(0, firstDuplicateIndex), ...oldMessages],
    nextCursor: existingCursor,
  }
}
