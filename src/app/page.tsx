"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/trpc/client";
import { useMutation } from "@tanstack/react-query";
import React, { useState } from "react";
import { toast } from "sonner";

const Page = () => {
  const [value, setValue] = useState("");

  const trpc = useTRPC();
  const invoke = useMutation(
    trpc.hello.mutationOptions({
      onSuccess: () => {
        toast.success("Job queued.");
      },
    })
  );

  return (
    <div className="p-4 max-w-7xl mx-auto">
      <Input value={value} onChange={(e) => setValue(e.target.value)} />
      <Button
        onClick={() => invoke.mutate({ value })}
        disabled={invoke.isPending}
      >
        {invoke.isPending ? "Invoking..." : "Invoke"}
      </Button>
    </div>
  );
};

export default Page;
