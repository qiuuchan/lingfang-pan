import { useEffect, useState } from 'react';
import { PackageCheckIcon, UserRoundCheckIcon } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApplicationsTab } from '@/components/governance/applications-tab';
import { PluginPackagesTab } from '@/components/governance/plugin-packages-tab';
import type { GovernanceIntent, GovernanceTab } from '@/components/governance/types';

export function GovernanceView({ intent }: { intent: GovernanceIntent }) {
  const [activeTab, setActiveTab] = useState<GovernanceTab>(intent.tab);

  useEffect(() => {
    setActiveTab(intent.tab);
  }, [intent.nonce, intent.tab]);

  return (
    <div className="space-y-5">
      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as GovernanceTab)}>
        <div className="overflow-x-auto scrollbar-thin">
          <TabsList className="min-w-max">
            <TabsTrigger value="plugins" className="gap-2">
              <PackageCheckIcon className="size-4" />
              插件发行
            </TabsTrigger>
            <TabsTrigger value="applications" className="gap-2">
              <UserRoundCheckIcon className="size-4" />
              团队管理员申请
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="plugins">
          <PluginPackagesTab
            key={`plugins-${intent.nonce}`}
            initialReviewStatus={intent.reviewStatus}
          />
        </TabsContent>
        <TabsContent value="applications">
          <ApplicationsTab
            key={`applications-${intent.nonce}`}
            initialStatus={intent.applicationStatus}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
