import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  hasEmployeeFieldErrors,
  isDigitalEmployee,
  parseEmployeeKind,
  validateEmployeeInput,
  type EmployeeFieldErrors,
  type EmployeeInput,
  type EmployeeKind,
  type PublicEmployee,
} from "@workee/shared";
import { Button } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { employeeApi } from "@/services/employee.service";

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
  const initialKind = employee ? parseEmployeeKind(employee.kind) : null;
  const [kind, setKind] = useState<EmployeeKind | null>(initialKind);
  const [name, setName] = useState(employee?.name ?? "");
  const [surname, setSurname] = useState(employee?.surname ?? "");
  const [nickname, setNickname] = useState(employee?.nickname ?? "");
  const [email, setEmail] = useState(employee?.email ?? "");
  const [phone, setPhone] = useState(employee?.phone ?? "");
  const [model, setModel] = useState(employee?.model ?? "");
  const [temperature, setTemperature] = useState(
    employee?.temperature != null ? String(employee.temperature) : "0",
  );
  const [instructions, setInstructions] = useState(employee?.instructions ?? "");
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  const [touched, setTouched] = useState({
    name: false,
    surname: false,
    nickname: false,
    email: false,
    phone: false,
    model: false,
    temperature: false,
    instructions: false,
  });

  useEffect(() => {
    if (mode !== "add" || kind !== "digital" || employee) {
      return;
    }

    let cancelled = false;
    employeeApi
      .digitalDefaults()
      .then((defaults) => {
        if (cancelled) {
          return;
        }
        setModel((current) => current || defaults.model);
        setTemperature((current) => (current ? current : String(defaults.temperature)));
        setInstructions((current) => current || defaults.instructions);
      })
      .catch(() => {
        if (!cancelled) {
          setDefaultsError("Unable to load default Workee settings.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [employee, kind, mode]);

  const fieldErrors = useMemo(
    () =>
      validateEmployeeInput({
        kind: kind ?? "human",
        name,
        surname,
        nickname,
        email,
        phone,
        model,
        temperature,
        instructions,
      }),
    [email, instructions, kind, model, name, nickname, phone, surname, temperature],
  );

  const visibleErrors: EmployeeFieldErrors = {
    name: touched.name ? fieldErrors.name : undefined,
    surname: touched.surname ? fieldErrors.surname : undefined,
    nickname: touched.nickname ? fieldErrors.nickname : undefined,
    email: touched.email ? fieldErrors.email : undefined,
    phone: touched.phone ? fieldErrors.phone : undefined,
    model: touched.model ? fieldErrors.model : undefined,
    temperature: touched.temperature ? fieldErrors.temperature : undefined,
    instructions: touched.instructions ? fieldErrors.instructions : undefined,
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!kind) {
      return;
    }

    setTouched({
      name: true,
      surname: true,
      nickname: true,
      email: true,
      phone: true,
      model: true,
      temperature: true,
      instructions: true,
    });

    if (hasEmployeeFieldErrors(fieldErrors)) {
      return;
    }

    if (kind === "digital") {
      await onSubmit({
        kind,
        name: name.trim(),
        surname: "",
        nickname: nickname.trim() || name.trim(),
        model: model.trim(),
        temperature: Number(temperature),
        instructions: instructions.trim(),
      });
      return;
    }

    await onSubmit({
      kind,
      name: name.trim(),
      surname: surname.trim(),
      nickname: nickname.trim(),
      email: email.trim(),
      phone: phone.trim(),
    });
  }

  const title = mode === "add" ? "Add employee" : "Update employee";
  const showKindPicker = mode === "add" && kind === null;
  const digital = kind === "digital" || Boolean(employee && isDigitalEmployee(employee));

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
        className={`max-h-[90vh] w-full overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg ${
          digital ? "max-w-2xl" : "max-w-md"
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="employee-dialog-title"
          className="text-lg font-semibold text-text-primary"
        >
          {title}
        </h2>

        {showKindPicker ? (
          <div className="mt-5 flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              Choose the type of employee to add.
            </p>
            <Button
              onClick={() => setKind("human")}
              className="sm:w-auto"
            >
              Person
            </Button>
            <Button
              variant="ghost"
              onClick={() => setKind("digital")}
              className="border border-border bg-background text-text-primary hover:bg-primary-light sm:w-auto"
            >
              Workee (digital)
            </Button>
            <Button variant="ghost" onClick={onClose} className="sm:w-auto">
              Cancel
            </Button>
          </div>
        ) : (
          <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            {mode === "add" ? (
              <button
                type="button"
                className="self-start text-sm font-medium text-primary hover:underline"
                onClick={() => setKind(null)}
              >
                Back to type
              </button>
            ) : (
              <p className="text-sm text-text-secondary">
                {digital ? "Workee (digital)" : "Person"}
              </p>
            )}
            <Input
              name="employee-name"
              label="Name"
              value={name}
              error={visibleErrors.name}
              onBlur={() => setTouched((current) => ({ ...current, name: true }))}
              onChange={(event) => setName(event.target.value)}
            />
            {digital ? (
              <>
                <Input
                  name="employee-nickname"
                  label="Nickname"
                  value={nickname}
                  error={visibleErrors.nickname}
                  onBlur={() => setTouched((current) => ({ ...current, nickname: true }))}
                  onChange={(event) => setNickname(event.target.value)}
                />
                <Input
                  name="employee-model"
                  label="Model"
                  value={model}
                  error={visibleErrors.model}
                  onBlur={() => setTouched((current) => ({ ...current, model: true }))}
                  onChange={(event) => setModel(event.target.value)}
                />
                <Input
                  name="employee-temperature"
                  type="number"
                  min={0}
                  max={2}
                  step="0.1"
                  label="Temperature"
                  value={temperature}
                  error={visibleErrors.temperature}
                  onBlur={() =>
                    setTouched((current) => ({ ...current, temperature: true }))
                  }
                  onChange={(event) => setTemperature(event.target.value)}
                />
                <Textarea
                  name="employee-instructions"
                  label="Instructions"
                  value={instructions}
                  error={visibleErrors.instructions}
                  onBlur={() =>
                    setTouched((current) => ({ ...current, instructions: true }))
                  }
                  onChange={(event) => setInstructions(event.target.value)}
                />
              </>
            ) : (
              <>
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
              </>
            )}
            {defaultsError ? (
              <p role="alert" className="text-sm text-error">
                {defaultsError}
              </p>
            ) : null}
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
        )}
      </div>
    </div>
  );
}
