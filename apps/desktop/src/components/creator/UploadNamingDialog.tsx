import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/loading-button';

interface UploadNamingDialogProps {
  open: boolean;
  value: string;
  priceYuan: string;
  loading: boolean;
  onOpenChange: (open: boolean) => void;
  onValueChange: (value: string) => void;
  onPriceYuanChange: (value: string) => void;
  onSubmit: () => void;
}

export function UploadNamingDialog({
  open,
  value,
  priceYuan,
  loading,
  onOpenChange,
  onValueChange,
  onPriceYuanChange,
  onSubmit,
}: UploadNamingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!loading) onOpenChange(nextOpen); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>命名并上传插件</DialogTitle>
          <DialogDescription>给插件起个名字，团队成员将通过这个名字找到它。</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="plugin-name-input">插件名称</Label>
          <Input
            id="plugin-name-input"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            placeholder="如：我的番茄钟"
            autoFocus
            onKeyDown={(event) => event.key === 'Enter' && !loading && onSubmit()}
          />
          <Label htmlFor="plugin-price-input">定价（元，留空=免费）</Label>
          <Input
            id="plugin-price-input"
            value={priceYuan}
            onChange={(event) => onPriceYuanChange(event.target.value)}
            placeholder="0 表示免费"
            inputMode="decimal"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>取消</Button>
          <LoadingButton onClick={onSubmit} loading={loading}>上传</LoadingButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
