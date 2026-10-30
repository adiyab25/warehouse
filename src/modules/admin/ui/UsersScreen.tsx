'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import {
  createUserAction,
  resetPasswordAction,
  setUserActiveAction,
  setUserRoleAction,
} from '@/app/(app)/users/actions';
import { t, type Lang } from '@/i18n';
import {
  ADMIN_REFUSAL_MESSAGE_KEYS,
  MIN_PASSWORD_LENGTH,
  type AdminRefusal,
  type BranchOption,
  type RoleSummary,
  type UserSummary,
} from '../schema';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/modules/shell/ui/PageHeader';

/**
 * THE USERS SCREEN — create a person, give them a role and a branch, disable
 * them, and reset a password.
 *
 * Three things this screen deliberately does NOT offer, because the server
 * refuses them anyway and a button that always fails is worse than no button:
 * changing your OWN role, disabling YOUR OWN account, and removing the last
 * administrator. The screen hides them for people too; `selfId` is how it knows.
 *
 * A password is typed here and never comes back: after a successful reset the
 * field is cleared and the person's sessions are already ended server-side.
 */

export interface UsersScreenProps {
  lang: Lang;
  users: UserSummary[];
  roles: RoleSummary[];
  branches: BranchOption[];
  selfId: string;
}

export function UsersScreen({ lang, users, roles, branches, selfId }: UsersScreenProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<string>(roles[0]?.id ?? '');
  const [branchId, setBranchId] = useState<string>('');

  const [resetFor, setResetFor] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');

  function refusal(code: AdminRefusal) {
    setMessage(t(ADMIN_REFUSAL_MESSAGE_KEYS[code] ?? ADMIN_REFUSAL_MESSAGE_KEYS.invalid, lang));
  }

  async function run(work: () => Promise<{ ok: true } | { ok: false; code: AdminRefusal }>, done?: () => void) {
    setBusy(true);
    setMessage(null);
    const answer = await work();
    setBusy(false);
    if (answer.ok) {
      done?.();
      startTransition(() => router.refresh());
    } else {
      refusal(answer.code);
    }
  }

  return (
    <>
      <PageHeader title={t('admin.users.title', lang)} subtitle={t('admin.users.subtitle', lang)} />

      {message && (
        <p className="mb-3 rounded-md border px-3 py-2 text-sm" role="status">
          {message}
        </p>
      )}

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">{t('admin.users.new', lang)}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="user-name">{t('admin.users.name', lang)}</Label>
            <Input id="user-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-username">{t('admin.users.username', lang)}</Label>
            <Input
              id="user-username"
              className="ltr-value"
              dir="ltr"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="user-password">{t('admin.users.password', lang)}</Label>
            <Input
              id="user-password"
              type="password"
              dir="ltr"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('admin.users.password_hint', { lang, params: { count: MIN_PASSWORD_LENGTH } })}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('admin.users.role', lang)}</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((role) => (
                  <SelectItem key={role.id} value={role.id}>
                    {role.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>{t('admin.users.branch', lang)}</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder={t('admin.users.no_branch', lang)} />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    {branch.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={busy || pending || name.trim() === '' || username.trim() === '' || password === ''}
              onClick={() =>
                run(
                  () =>
                    createUserAction({
                      name,
                      username,
                      password,
                      roleId,
                      branchLocationId: branchId === '' ? null : branchId,
                    }),
                  () => {
                    setName('');
                    setUsername('');
                    setPassword('');
                    setBranchId('');
                  },
                )
              }
            >
              {t('admin.users.create', lang)}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('admin.users.list', lang)}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {users.map((person) => {
            const isSelf = person.id === selfId;
            return (
              <div key={person.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {person.name}
                      {isSelf && (
                        <span className="ms-2 text-xs text-muted-foreground">
                          ({t('admin.users.you', lang)})
                        </span>
                      )}
                    </p>
                    <p className="ltr-value text-xs text-muted-foreground" dir="ltr">
                      {person.username}
                    </p>
                    {person.branchLabel && (
                      <p className="text-xs text-muted-foreground">{person.branchLabel}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {person.active ? (
                      <Badge>{t('admin.users.active', lang)}</Badge>
                    ) : (
                      <Badge variant="outline">{t('admin.users.disabled', lang)}</Badge>
                    )}

                    <Select
                      value={person.roleId ?? ''}
                      onValueChange={(next) =>
                        run(() => setUserRoleAction({ userId: person.id, roleId: next }))
                      }
                      disabled={isSelf || busy}
                    >
                      <SelectTrigger className="w-40">
                        <SelectValue placeholder={t('admin.users.no_role', lang)} />
                      </SelectTrigger>
                      <SelectContent>
                        {roles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    <Button
                      variant="outline"
                      size="sm"
                      disabled={isSelf || busy}
                      onClick={() =>
                        run(() => setUserActiveAction({ userId: person.id, active: !person.active }))
                      }
                    >
                      {person.active ? t('admin.users.disable', lang) : t('admin.users.enable', lang)}
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setResetFor(resetFor === person.id ? null : person.id);
                        setNewPassword('');
                      }}
                    >
                      {t('admin.users.reset', lang)}
                    </Button>
                  </div>
                </div>

                {resetFor === person.id && (
                  <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
                    <div className="space-y-1">
                      <Label htmlFor={`reset-${person.id}`}>{t('admin.users.new_password', lang)}</Label>
                      <Input
                        id={`reset-${person.id}`}
                        type="password"
                        dir="ltr"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                      />
                    </div>
                    <Button
                      size="sm"
                      disabled={busy || newPassword.length < MIN_PASSWORD_LENGTH}
                      onClick={() =>
                        run(
                          () => resetPasswordAction({ userId: person.id, password: newPassword }),
                          () => {
                            setResetFor(null);
                            setNewPassword('');
                          },
                        )
                      }
                    >
                      {t('admin.users.reset_save', lang)}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </>
  );
}
