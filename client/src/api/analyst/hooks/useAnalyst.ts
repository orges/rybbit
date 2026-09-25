"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addMemory,
  deleteConversation,
  deleteMemory,
  getConversation,
  listConversations,
  listMemories,
  renameConversation,
} from "../endpoints/analyst";

export const analystKeys = {
  conversations: (organizationId: string, siteId: number) => ["analyst", "conversations", organizationId, siteId] as const,
  conversation: (organizationId: string, siteId: number, id: string) => ["analyst", "conversation", organizationId, siteId, id] as const,
  memories: (organizationId: string, siteId: number) => ["analyst", "memories", organizationId, siteId] as const,
};

export function useConversations(organizationId: string | undefined, siteId: number, enabled = true) {
  return useQuery({
    queryKey: analystKeys.conversations(organizationId ?? "", siteId),
    queryFn: () => listConversations(organizationId!, siteId),
    enabled: enabled && !!organizationId,
    staleTime: 30_000,
  });
}

export function useConversation(organizationId: string | undefined, siteId: number, id: string | null) {
  return useQuery({
    queryKey: analystKeys.conversation(organizationId ?? "", siteId, id ?? ""),
    queryFn: () => getConversation(organizationId!, siteId, id!),
    enabled: !!organizationId && !!id,
  });
}

export function useDeleteConversation(organizationId: string, siteId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteConversation(organizationId, siteId, id),
    onSuccess: () => client.invalidateQueries({ queryKey: analystKeys.conversations(organizationId, siteId) }),
  });
}

export function useRenameConversation(organizationId: string, siteId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) => renameConversation(organizationId, siteId, id, title),
    onSuccess: () => client.invalidateQueries({ queryKey: analystKeys.conversations(organizationId, siteId) }),
  });
}

export function useMemories(organizationId: string | undefined, siteId: number) {
  return useQuery({
    queryKey: analystKeys.memories(organizationId ?? "", siteId),
    queryFn: () => listMemories(organizationId!, siteId),
    enabled: !!organizationId,
  });
}

export function useAddMemory(organizationId: string, siteId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => addMemory(organizationId, siteId, content),
    onSuccess: () => client.invalidateQueries({ queryKey: analystKeys.memories(organizationId, siteId) }),
  });
}

export function useDeleteMemory(organizationId: string, siteId: number) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteMemory(organizationId, siteId, id),
    onSuccess: () => client.invalidateQueries({ queryKey: analystKeys.memories(organizationId, siteId) }),
  });
}
