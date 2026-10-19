"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useAction } from "next-safe-action/hooks";
import { MailIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/Input";
import { Label } from "@/components/ui/label";
import { MutedText } from "@/components/Typography";
import { toastError, toastSuccess } from "@/components/Toast";
import { getActionErrorMessage } from "@/utils/error";
import { connectImapMailboxAction } from "@/utils/actions/mailbox-credentials";
import {
  connectImapMailboxBody,
  type ConnectImapMailboxBody,
} from "@/utils/actions/mailbox-credentials.validation";
import { getImapPreset } from "@/utils/imap/presets";
import type { ProviderFamily } from "@/utils/email/provider-registry";

/** The families with a preset, plus the generic server. */
const CONNECTABLE = [
  { value: "zoho", label: "Zoho Mail" },
  { value: "fastmail", label: "Fastmail" },
  { value: "yahoo", label: "Yahoo Mail" },
  { value: "icloud", label: "iCloud Mail" },
  { value: "imap", label: "Other mail server (IMAP)" },
] as const;

/**
 * Connects a mailbox with an app password.
 *
 * The provider picker is what decides the preset, so the common case is an
 * address and a password; only "other" asks for hostnames.
 */
export function ConnectImapAccount() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const form = useForm<ConnectImapMailboxBody>({
    resolver: zodResolver(connectImapMailboxBody),
    defaultValues: {
      provider: "zoho",
      email: "",
      secret: "",
    },
  });

  const provider = form.watch("provider");
  const preset = getImapPreset(provider as ProviderFamily);
  const needsHostnames = !preset;

  const { execute, isExecuting } = useAction(connectImapMailboxAction, {
    onSuccess: ({ data }) => {
      toastSuccess({
        title: data?.created ? "Mailbox connected" : "Mailbox reconnected",
        description: "Mail will start syncing shortly.",
      });
      setOpen(false);
      form.reset();
      router.refresh();
    },
    onError: ({ error }) =>
      toastError({ description: getActionErrorMessage(error) }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full">
          <MailIcon className="mr-2 size-5" />
          Add other mail
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a mailbox</DialogTitle>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={form.handleSubmit((values) => execute(values))}
        >
          <div className="space-y-2">
            <Label htmlFor="provider">Mail provider</Label>
            <select
              id="provider"
              className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              {...form.register("provider")}
            >
              {CONNECTABLE.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <Input
            name="email"
            type="email"
            label="Email address"
            placeholder="you@example.com"
            error={form.formState.errors.email}
            registerProps={form.register("email")}
          />

          <div className="space-y-2">
            <Input
              name="secret"
              type="password"
              label="App password"
              error={form.formState.errors.secret}
              registerProps={form.register("secret")}
            />
            <MutedText className="text-xs">
              {preset?.passwordHint ??
                "Usually an app password rather than the password you sign in with."}
            </MutedText>
          </div>

          {needsHostnames && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                name="imapHost"
                type="text"
                label="IMAP host"
                placeholder="imap.example.com"
                error={form.formState.errors.imapHost}
                registerProps={form.register("imapHost")}
              />
              <Input
                name="imapPort"
                type="number"
                label="IMAP port"
                placeholder="993"
                error={form.formState.errors.imapPort}
                registerProps={form.register("imapPort", {
                  valueAsNumber: true,
                })}
              />
              <Input
                name="smtpHost"
                type="text"
                label="SMTP host"
                placeholder="smtp.example.com"
                error={form.formState.errors.smtpHost}
                registerProps={form.register("smtpHost")}
              />
              <Input
                name="smtpPort"
                type="number"
                label="SMTP port"
                placeholder="465"
                error={form.formState.errors.smtpPort}
                registerProps={form.register("smtpPort", {
                  valueAsNumber: true,
                })}
              />
            </div>
          )}

          <MutedText className="text-xs">
            OneMail signs in to your mail server directly with the password you
            enter here. It is encrypted before it is stored.
          </MutedText>

          <Button type="submit" loading={isExecuting} className="w-full">
            Connect
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
