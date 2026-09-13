import { FormEvent, useState } from "react";
import type { EmployeeRecordField, EmployeeRecordItem } from "@workee/shared";
import { Button } from "./Button";
import { Input } from "./Input";

interface EmployeeRecordDialogProps {
  item: EmployeeRecordItem;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (fields: EmployeeRecordField[]) => Promise<void>;
}

export function EmployeeRecordDialog({
  item,
  submitting,
  error,
  onClose,
  onSubmit,
}: EmployeeRecordDialogProps) {
  const [fields, setFields] = useState<EmployeeRecordField[]>(
    item.fields.length > 0
      ? item.fields
      : [{ label: "Name", value: item.title }],
  );

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(fields);
  }

  return (
    <div
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-dialog-title"
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2
          id="record-dialog-title"
          className="text-lg font-semibold text-text-primary"
        >
          Edit item
        </h2>
        <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit}>
          {fields.map((field, index) => (
            <Input
              key={`${field.label}-${index}`}
              name={`record-field-${index}`}
              label={field.label}
              value={field.value}
              onChange={(event) => {
                const value = event.target.value;
                setFields((current) =>
                  current.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, value } : entry,
                  ),
                );
              }}
            />
          ))}
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
              Save
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
