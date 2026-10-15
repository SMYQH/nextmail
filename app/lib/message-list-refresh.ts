export interface MessageListRefreshResult<T> {
  messages: T[]
  nextCursor: string | null
}

export function mergeRefreshedMessages<T extends { id: string }>(
  newMessages: T[],
  oldMessages: T[],
  firstPageCursor: string | null,
  existingCursor: string | null,
  isPaginatedItem: (item: T) => boolean = () => true,
): MessageListRefreshResult<T> {
  const firstDuplicateIndex = newMessages.findIndex(newMessage =>
    isPaginatedItem(newMessage) && oldMessages.some(oldMessage =>
      isPaginatedItem(oldMessage) && oldMessage.id === newMessage.id
    )
  )

  if (firstDuplicateIndex === -1) {
    return {
      messages: newMessages,
      nextCursor: firstPageCursor,
    }
  }

  return {
    messages: [...newMessages, ...oldMessages.filter(message =>
      isPaginatedItem(message) && !newMessages.some(updated => updated.id === message.id)
    )],
    nextCursor: existingCursor,
  }
}
