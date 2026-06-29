// search/search.controller.ts —— /api/search 多源聚合搜索端点。
//
// 设计：
//  - 非 @Public：要求登录态（JWT），杜绝匿名刷外部搜索资源；与 relay「计费咽喉」同思路收紧限流。
//  - 不需要任何用户密钥：密钥（如有）由管理员在后台配置，服务端持有；用户只发 query。
//  - 限流：外部搜索是出站资源，限 20/min/IP，防滥用。
import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { SearchService } from './search.service';
import { SearchQueryDto, WebFetchDto } from './dto/search.dto';

@ApiTags('Search')
@Controller('search')
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

  @Post()
  @ApiOperation({ summary: '多源聚合网络搜索（免用户密钥，内置默认启用，自动跳过不可达源）' })
  query(@Body() dto: SearchQueryDto) {
    return this.search.search(dto.query, dto.limit);
  }

  @Post('fetch')
  @ApiOperation({ summary: '抓取网页正文（WebFetch，经正文抽取+markdown 化，服务端可达 Jina）' })
  fetchPage(@Body() dto: WebFetchDto) {
    return this.search.fetchPage(dto.url, dto.maxLength);
  }
}
