import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  const { t } = useTranslation();
  return (
    <Loader2Icon
      aria-label={t("common.loading")}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
