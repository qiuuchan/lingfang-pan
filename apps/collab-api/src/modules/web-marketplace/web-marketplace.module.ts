import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { WebMarketplaceController } from './web-marketplace.controller';
import { WebMarketplaceService } from './web-marketplace.service';
import { AuthService } from '../auth.service';
import { MailService } from '../mail.service';
import { GeetestService } from '../geetest.service';
import { WebPreviewSessionController } from './web-preview-session.controller';
import { WebPreviewSessionService } from './web-preview-session.service';
import { WebCloudTrialController } from './web-cloud-trial.controller';
import { WebCloudTrialService } from './web-cloud-trial.service';
import { PluginActionRegistryService } from '../plugin-action-registry.service';
import { CloudActionRoutingService } from '../cloud-action-routing.service';
import { ActionInvocationService } from '../action-invocation.service';
import { GovernanceActionAdapter } from '../governance-action-adapter';
import { PluginGovernanceService } from '../plugin-governance.service';
import { PluginGovernancePolicyService } from '../plugin-governance-policy.service';
import { WebSessionController } from './web-session.controller';
import { WebSessionService } from './web-session.service';
import { MarketplaceDiscoveryService } from '../marketplace-discovery.service';
import { MarketplaceCommerceService } from '../marketplace-commerce.service';
import { MarketplaceCommerceQueryService } from '../marketplace-commerce-query.service';
import { WebPreviewAssetController } from './web-preview-asset.controller';
import { WebPreviewAssetService } from './web-preview-asset.service';
import { ARTIFACT_STORE, createArtifactStore } from '../artifact-store';

@Module({
  controllers: [WebMarketplaceController, WebPreviewSessionController, WebPreviewAssetController, WebCloudTrialController, WebSessionController],
  providers: [PrismaService, AuthService, MailService, GeetestService, MarketplaceDiscoveryService, MarketplaceCommerceService, MarketplaceCommerceQueryService, WebMarketplaceService, WebPreviewSessionService, WebPreviewAssetService, WebCloudTrialService, WebSessionService, PluginActionRegistryService, CloudActionRoutingService, ActionInvocationService, GovernanceActionAdapter, PluginGovernanceService, PluginGovernancePolicyService, { provide: ARTIFACT_STORE, useFactory: () => createArtifactStore() }],
})
export class WebMarketplaceModule {}
