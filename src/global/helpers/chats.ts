import type {
  ApiChat,
  ApiUser,
  ApiChatBannedRights,
  ApiChatAdminRights,
  ApiChatFolder, ApiTopic, ApiUserFullInfo,
} from '../../api/types';
import {
  MAIN_THREAD_ID,
} from '../../api/types';

import type { NotifyException, NotifySettings } from '../../types';
import type { LangFn } from '../../hooks/useLang';

import {
  ARCHIVED_FOLDER_ID, GENERAL_TOPIC_ID, REPLIES_USER_ID, TME_LINK_PREFIX,
} from '../../config';
import { orderBy } from '../../util/iteratees';
import { getUserFirstOrLastName } from './users';
import { formatDateToString, formatTime } from '../../util/dateFormat';
import { prepareSearchWordsForNeedle } from '../../util/searchWords';
import { getVideoAvatarMediaHash } from './media';

const FOREVER_BANNED_DATE = Date.now() / 1000 + 31622400; // 366 days

const VERIFIED_PRIORITY_BASE = 3e9;
const PINNED_PRIORITY_BASE = 3e8;

export function isUserId(entityId: string) {
  // Workaround for old-fashioned IDs stored locally
  if (typeof entityId === 'number') {
    return entityId > 0;
  }

  return !entityId.startsWith('-');
}

export function isChatGroup(chat: ApiChat) {
  return isChatBasicGroup(chat) || isChatSuperGroup(chat);
}

export function isChatBasicGroup(chat: ApiChat) {
  return chat.type === 'chatTypeBasicGroup';
}

export function isChatSuperGroup(chat: ApiChat) {
  return chat.type === 'chatTypeSuperGroup';
}

export function isChatChannel(chat: ApiChat) {
  return chat.type === 'chatTypeChannel';
}

export function isCommonBoxChat(chat: ApiChat) {
  return chat.type === 'chatTypePrivate' || chat.type === 'chatTypeBasicGroup';
}

export function isChatWithRepliesBot(chatId: string) {
  return chatId === REPLIES_USER_ID;
}

export function getChatTypeString(chat: ApiChat) {
  switch (chat.type) {
    case 'chatTypePrivate':
      return 'PrivateChat';
    case 'chatTypeBasicGroup':
    case 'chatTypeSuperGroup':
      return 'AccDescrGroup';
    case 'chatTypeChannel':
      return 'AccDescrChannel';
    default:
      return 'Chat';
  }
}

export function getPrivateChatUserId(chat: ApiChat) {
  if (chat.type !== 'chatTypePrivate' && chat.type !== 'chatTypeSecret') {
    return undefined;
  }
  return chat.id;
}

// TODO Get rid of `user`
export function getChatTitle(lang: LangFn, chat: ApiChat, user?: ApiUser, isSelf = false) {
  if (isSelf || (user && chat.id === user.id && user.isSelf)) {
    return lang('SavedMessages');
  }
  return chat.title || lang('HiddenName');
}

export function getChatDescription(chat: ApiChat) {
  if (!chat.fullInfo) {
    return undefined;
  }
  return chat.fullInfo.about;
}

export function getChatLink(chat: ApiChat) {
  const { usernames } = chat;
  if (usernames) {
    const activeUsername = usernames.find((u) => u.isActive);
    if (activeUsername) {
      return `${TME_LINK_PREFIX}${activeUsername.username}`;
    }
  }

  const { inviteLink } = chat.fullInfo || {};

  return inviteLink;
}

export function getChatMessageLink(chatId: string, chatUsername?: string, threadId?: number, messageId?: number) {
  const chatPart = chatUsername || `c/${chatId.replace('-', '')}`;
  const threadPart = threadId && threadId !== MAIN_THREAD_ID ? `/${threadId}` : '';
  const messagePart = messageId ? `/${messageId}` : '';
  return `${TME_LINK_PREFIX}${chatPart}${threadPart}${messagePart}`;
}

export function getTopicLink(chatId: string, chatUsername?: string, topicId?: number) {
  return getChatMessageLink(chatId, chatUsername, topicId);
}

export function getChatAvatarHash(
  owner: ApiChat | ApiUser,
  size: 'normal' | 'big' = 'normal',
  type: 'photo' | 'video' = 'photo',
  avatarHash = owner.avatarHash,
) {
  if (!avatarHash) {
    return undefined;
  }
  const { fullInfo } = owner;

  if (type === 'video') {
    const userFullInfo = isUserId(owner.id) ? fullInfo as ApiUserFullInfo : undefined;
    if (userFullInfo?.personalPhoto?.isVideo) {
      return getVideoAvatarMediaHash(userFullInfo.personalPhoto);
    }
    if (fullInfo?.profilePhoto?.isVideo) {
      return getVideoAvatarMediaHash(fullInfo.profilePhoto);
    }
    if (userFullInfo?.fallbackPhoto?.isVideo) {
      return getVideoAvatarMediaHash(userFullInfo.fallbackPhoto);
    }
    return undefined;
  }

  switch (size) {
    case 'big':
      return `profile${owner.id}?${avatarHash}`;
    default:
      return `avatar${owner.id}?${avatarHash}`;
  }
}

export function isChatSummaryOnly(chat: ApiChat) {
  return !chat.lastMessage;
}

export function isChatAdmin(chat: ApiChat) {
  return Boolean(chat.adminRights);
}

export function getHasAdminRight(chat: ApiChat, key: keyof ApiChatAdminRights) {
  return chat.adminRights ? chat.adminRights[key] : false;
}

export function getCanManageTopic(chat: ApiChat, topic: ApiTopic) {
  if (topic.id === GENERAL_TOPIC_ID) return chat.isCreator;
  return chat.isCreator || getHasAdminRight(chat, 'manageTopics') || topic.isOwner;
}

export function isUserRightBanned(chat: ApiChat, key: keyof ApiChatBannedRights) {
  return Boolean(
    (chat.currentUserBannedRights?.[key])
    || (chat.defaultBannedRights?.[key]),
  );
}

export function getCanPostInChat(chat: ApiChat, threadId: number, isComments?: boolean) {
  if (threadId !== MAIN_THREAD_ID) {
    if (chat.isForum) {
      if (chat.isNotJoined) {
        return false;
      }

      const topic = chat.topics?.[threadId];
      if (topic?.isClosed && !topic.isOwner && !getHasAdminRight(chat, 'manageTopics')) {
        return false;
      }
    }
  }

  if (chat.isRestricted || chat.isForbidden || chat.migratedTo
    || (!isComments && chat.isNotJoined) || isChatWithRepliesBot(chat.id)) {
    return false;
  }

  if (chat.isCreator) {
    return true;
  }

  if (isUserId(chat.id)) {
    return true;
  }

  if (isChatChannel(chat)) {
    return getHasAdminRight(chat, 'postMessages');
  }

  return isChatAdmin(chat) || !isUserRightBanned(chat, 'sendMessages');
}

export interface IAllowedAttachmentOptions {
  canAttachMedia: boolean;
  canAttachPolls: boolean;
  canSendStickers: boolean;
  canSendGifs: boolean;
  canAttachEmbedLinks: boolean;
  canSendPhotos: boolean;
  canSendVideos: boolean;
  canSendRoundVideos: boolean;
  canSendAudios: boolean;
  canSendVoices: boolean;
  canSendPlainText: boolean;
  canSendDocuments: boolean;
}

export function getAllowedAttachmentOptions(chat?: ApiChat, isChatWithBot = false): IAllowedAttachmentOptions {
  if (!chat) {
    return {
      canAttachMedia: false,
      canAttachPolls: false,
      canSendStickers: false,
      canSendGifs: false,
      canAttachEmbedLinks: false,
      canSendPhotos: false,
      canSendVideos: false,
      canSendRoundVideos: false,
      canSendAudios: false,
      canSendVoices: false,
      canSendPlainText: false,
      canSendDocuments: false,
    };
  }

  const isAdmin = isChatAdmin(chat);

  return {
    canAttachMedia: isAdmin || !isUserRightBanned(chat, 'sendMedia'),
    canAttachPolls: (isAdmin || !isUserRightBanned(chat, 'sendPolls')) && (!isUserId(chat.id) || isChatWithBot),
    canSendStickers: isAdmin || !isUserRightBanned(chat, 'sendStickers'),
    canSendGifs: isAdmin || !isUserRightBanned(chat, 'sendGifs'),
    canAttachEmbedLinks: isAdmin || !isUserRightBanned(chat, 'embedLinks'),
    canSendPhotos: isAdmin || !isUserRightBanned(chat, 'sendPhotos'),
    canSendVideos: isAdmin || !isUserRightBanned(chat, 'sendVideos'),
    canSendRoundVideos: isAdmin || !isUserRightBanned(chat, 'sendRoundvideos'),
    canSendAudios: isAdmin || !isUserRightBanned(chat, 'sendAudios'),
    canSendVoices: isAdmin || !isUserRightBanned(chat, 'sendVoices'),
    canSendPlainText: isAdmin || !isUserRightBanned(chat, 'sendPlain'),
    canSendDocuments: isAdmin || !isUserRightBanned(chat, 'sendDocs'),
  };
}

export function getMessageSendingRestrictionReason(
  lang: LangFn,
  currentUserBannedRights?: ApiChatBannedRights,
  defaultBannedRights?: ApiChatBannedRights,
) {
  if (currentUserBannedRights?.sendMessages) {
    const { untilDate } = currentUserBannedRights;
    return untilDate && untilDate < FOREVER_BANNED_DATE
      ? lang(
        'Channel.Persmission.Denied.SendMessages.Until',
        lang(
          'formatDateAtTime',
          [formatDateToString(new Date(untilDate * 1000), lang.code), formatTime(lang, untilDate * 1000)],
        ),
      )
      : lang('Channel.Persmission.Denied.SendMessages.Forever');
  }

  if (defaultBannedRights?.sendMessages) {
    return lang('Channel.Persmission.Denied.SendMessages.DefaultRestrictedText');
  }

  return undefined;
}

export function getForumComposerPlaceholder(
  lang: LangFn, chat?: ApiChat, threadId = MAIN_THREAD_ID, isReplying?: boolean,
) {
  if (!chat?.isForum) {
    return undefined;
  }

  if (threadId === MAIN_THREAD_ID) {
    if (isReplying || (chat.topics && !chat.topics[GENERAL_TOPIC_ID]?.isClosed)) return undefined;
    return lang('lng_forum_replies_only');
  }

  const topic = chat.topics?.[threadId];
  if (!topic) {
    return undefined;
  }

  if (topic.isClosed && !topic.isOwner && !getHasAdminRight(chat, 'manageTopics')) {
    return lang('TopicClosedByAdmin');
  }

  return undefined;
}

export function getChatSlowModeOptions(chat?: ApiChat) {
  if (!chat || !chat.fullInfo) {
    return undefined;
  }

  return chat.fullInfo.slowMode;
}

export function isChatArchived(chat: ApiChat) {
  return chat.folderId === ARCHIVED_FOLDER_ID;
}

export function selectIsChatMuted(
  chat: ApiChat, notifySettings: NotifySettings, notifyExceptions: Record<string, NotifyException> = {},
) {
  // If this chat is in exceptions they take precedence
  if (notifyExceptions[chat.id] && notifyExceptions[chat.id].isMuted !== undefined) {
    return notifyExceptions[chat.id].isMuted;
  }

  return (
    chat.isMuted
    || (isUserId(chat.id) && !notifySettings.hasPrivateChatsNotifications)
    || (isChatChannel(chat) && !notifySettings.hasBroadcastNotifications)
    || (isChatGroup(chat) && !notifySettings.hasGroupNotifications)
  );
}

export function selectShouldShowMessagePreview(
  chat: ApiChat, notifySettings: NotifySettings, notifyExceptions: Record<string, NotifyException> = {},
) {
  const {
    hasPrivateChatsMessagePreview = true,
    hasBroadcastMessagePreview = true,
    hasGroupMessagePreview = true,
  } = notifySettings;
  // If this chat is in exceptions they take precedence
  if (notifyExceptions[chat.id] && notifyExceptions[chat.id].shouldShowPreviews !== undefined) {
    return notifyExceptions[chat.id].shouldShowPreviews;
  }

  return (isUserId(chat.id) && hasPrivateChatsMessagePreview)
    || (isChatChannel(chat) && hasBroadcastMessagePreview)
    || (isChatGroup(chat) && hasGroupMessagePreview);
}

export function getCanDeleteChat(chat: ApiChat) {
  return isChatBasicGroup(chat) || ((isChatSuperGroup(chat) || isChatChannel(chat)) && chat.isCreator);
}

export function getFolderDescriptionText(lang: LangFn, folder: ApiChatFolder, chatsCount?: number) {
  const {
    id, title, emoticon, description, pinnedChatIds,
    excludedChatIds, includedChatIds,
    excludeArchived, excludeMuted, excludeRead,
    ...filters
  } = folder;

  // If folder has multiple additive filters or uses include/exclude lists,
  // we display folder chats count
  if (
    chatsCount !== undefined && (
      Object.values(filters).filter(Boolean).length > 1
      || (excludedChatIds?.length)
      || (includedChatIds?.length)
    )) {
    return lang('Chats', chatsCount);
  }

  // Otherwise, we return a short description of a single filter
  if (filters.bots) {
    return lang('FilterBots');
  } else if (filters.groups) {
    return lang('FilterGroups');
  } else if (filters.channels) {
    return lang('FilterChannels');
  } else if (filters.contacts) {
    return lang('FilterContacts');
  } else if (filters.nonContacts) {
    return lang('FilterNonContacts');
  } else {
    return undefined;
  }
}

export function getMessageSenderName(lang: LangFn, chatId: string, sender?: ApiUser | ApiChat) {
  if (!sender || isUserId(chatId)) {
    return undefined;
  }

  if (!isUserId(sender.id)) {
    if (chatId === sender.id) return undefined;

    return (sender as ApiChat).title;
  }

  sender = sender as ApiUser;

  if (sender.isSelf) {
    return lang('FromYou');
  }

  return getUserFirstOrLastName(sender);
}

export function sortChatIds(
  chatIds: string[],
  chatsById: Record<string, ApiChat>,
  shouldPrioritizeVerified = false,
  priorityIds?: string[],
) {
  return orderBy(chatIds, (id) => {
    const chat = chatsById[id];
    if (!chat) {
      return 0;
    }

    let priority = 0;

    if (chat.lastMessage) {
      priority += chat.lastMessage.date;
    }

    if (shouldPrioritizeVerified && chat.isVerified) {
      priority += VERIFIED_PRIORITY_BASE; // ~100 years in seconds
    }

    if (priorityIds && priorityIds.includes(id)) {
      priority = Date.now() + PINNED_PRIORITY_BASE + (priorityIds.length - priorityIds.indexOf(id));
    }

    return priority;
  }, 'desc');
}

export function filterChatsByName(
  lang: LangFn,
  chatIds: string[],
  chatsById: Record<string, ApiChat>,
  query?: string,
  currentUserId?: string,
) {
  if (!query) {
    return chatIds;
  }

  const searchWords = prepareSearchWordsForNeedle(query);

  return chatIds.filter((id) => {
    const chat = chatsById[id];
    if (!chat) {
      return false;
    }

    return searchWords(getChatTitle(lang, chat, undefined, id === currentUserId));
  });
}

export function isChatPublic(chat: ApiChat) {
  return chat.usernames?.some(({ isActive }) => isActive);
}

export function getOrderedTopics(
  topics: ApiTopic[], pinnedOrder?: number[], shouldSortByLastMessage = false,
): ApiTopic[] {
  if (shouldSortByLastMessage) {
    return topics.sort((a, b) => b.lastMessageId - a.lastMessageId);
  } else {
    const pinned = topics.filter((topic) => topic.isPinned);
    const ordered = topics
      .filter((topic) => !topic.isPinned && !topic.isHidden)
      .sort((a, b) => b.lastMessageId - a.lastMessageId);
    const hidden = topics.filter((topic) => !topic.isPinned && topic.isHidden)
      .sort((a, b) => b.lastMessageId - a.lastMessageId);

    const pinnedOrdered = pinnedOrder
      ? pinnedOrder.map((id) => pinned.find((topic) => topic.id === id)).filter(Boolean) : pinned;

    return [...pinnedOrdered, ...ordered, ...hidden];
  }
}
