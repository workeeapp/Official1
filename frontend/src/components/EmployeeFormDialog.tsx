import { FormEvent, useMemo, useState } from "react";
import {
  hasEmployeeFieldErrors,
  validateEmployeeInput,
  type EmployeeFieldErrors,
  type EmployeeInput,
  type PublicEmployee,
} from "@workee/shared";
import { Button } from "./Button";
import { Input } from "./Input";

interface EmployeeFormDialogProps {
  mode: "add" | "update";
  employee?: PublicEmployee | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (input: EmployeeInput) => Promise<void>;
}

export function EmployeeFormDialog({
  mode,
  employee,
  submitting,
  error,
  onClose,
  onSubmit,
}: EmployeeFormDialogProps) {
  const [name, setName] = useState(employee?.name ?? "");
  const [surname, setSurname] = useState(employee?.surname ?? "");
  const [nickname, setNickname] = useState(employee?.nickname ?? "");
  const [email, setEmail] = useState(employee?.email ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [touched, setTouched] = useState({
    name: false,
    surname: false,
    nickname: false,
    email: false,
    phone: false,
  });

  const fieldErrors = useMemo(
    () => validateEmployeeInput({ name, surname, nickname, email, phone }),
    [name, surname, nickname, email, phone],
  );

  const visibleErrors: EmployeeFieldErrors = {
    name: touched.name ? fieldErrors.name : undefined,
    surname: touched.surname ? fieldErrors.surname : undefined,
    nickname: touched.nickname ? fieldErrors.nickname : undefined,
    email: touched.email ? fieldErrors.email : undefined,
    phone: touched.phone ? fieldErrors.phone : undefined,
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTouched({
      name: true,
      surname: true,
      nickname: true,
      email: true,
      phone: true,
    });

    if (hasEmployeeFieldErrors(fieldErrors)) {
      return;
    }

    await onSubmit({
      name: name.trim(),
      surname: surname.trim(),
      nickname: nickname.trim(),
      email: email.trim(),
      phone: phone.trim(),
    });
  }

  const title = mode === "add" ? "Add employee" : "Update employee";

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="employee-dialog-title"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="employee-dialog-title"
          className="text-lg font-semibold text-text-primary"
        >
          {title}
        </h2>
        <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
          <Input
            name="employee-name"
            label="Name"
            value={name}
            error={visibleErrors.name}
            onBlur={() => setTouched((current) => ({ ...current, name: true }))}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            name="employee-surname"
            label="Surname"
            value={surname}
            error={visibleErrors.surname}
            onBlur={() => setTouched((current) => ({ ...current, surname: true }))}
            onChange={(event) => setSurname(event.target.value)}
          />
          <Input
            name="employee-nickname"
            label="Nickname"
            value={nickname}
            error={visibleErrors.nickname}
            onBlur={() => setTouched((current) => ({ ...current, nickname: true }))}
            onChange={(event) => setNickname(event.target.value)}
          />
          <Input
            name="employee-email"
            type="email"
            label="Email"
            value={email}
            error={visibleErrors.email}
            onBlur={() => setTouched((current) => ({ ...current, email: true }))}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            name="employee-phone"
            type="tel"
            label="Phone"
            value={phone}
            error={visibleErrors.phone}
            onBlur={() => setTouched((current) => ({ ...current, phone: true }))}
            onChange={(event) => setPhone(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-sm text-error">
              {error}
            </p>
          ) : null}
          <div className="mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onClose} className="sm:w-auto">
              Cancel
            </Button>
            <Button type="submit" loading={submitting} className="sm:w-auto">
              {mode === "add" ? "Add" : "Save"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
