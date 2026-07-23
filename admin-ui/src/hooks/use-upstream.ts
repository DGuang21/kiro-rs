import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listUpstreams,
  saveUpstream,
  deleteUpstream,
  type UpstreamConfig,
} from '@/api/upstream'

/** 补货上游配置列表（Mock：localStorage） */
export function useUpstreams() {
  return useQuery({
    queryKey: ['upstreams'],
    queryFn: listUpstreams,
    staleTime: 5000,
  })
}

export function useSaveUpstream() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (config: Partial<UpstreamConfig> & { name: string }) => saveUpstream(config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['upstreams'] }),
  })
}

export function useDeleteUpstream() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteUpstream(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['upstreams'] }),
  })
}
