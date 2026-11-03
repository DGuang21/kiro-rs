import { Network } from 'lucide-react'
import { PageHeader } from '@/components/console/page-header'
import { ProxyPoolDialog } from '@/components/proxy-pool-dialog'

export function ProxyPoolPage() {
  return (
    <div className="px-4 py-5 md:px-6">
      <PageHeader
        breadcrumbs={[{ label: '控制台' }, { label: '代理池', active: true }]}
        icon={<Network className="h-4 w-4" />}
        title="代理池"
        description="代理健康检测、自动恢复、凭据绑定与故障轮换管理。"
      />
      <ProxyPoolDialog embedded open onOpenChange={() => {}} />
    </div>
  )
}
