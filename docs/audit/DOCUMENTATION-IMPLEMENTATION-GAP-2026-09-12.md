# Nexora TMS — Gap entre Documentação e Implementação

**Data:** 2026-09-12  
**Escopo:** documentação, runtime, persistência, isolamento multi-tenant e dependências declaradas

## 1. Objetivo

Evitar que a documentação arquitetural seja interpretada como prova de implementação. Este relatório registra diferenças verificáveis entre o baseline arquitetural e os artefatos efetivamente presentes no repositório.

## 2. Confirmado no repositório

### Runtime

- Node.js `24.20.0` e pnpm `11.24.0` estão fixados no root `package.json`.
- Web usa Next.js `16.3.3` e React `19.2.8`.
- API usa NestJS `12.0.1`, `pg`, `jose`, `reflect-metadata` e RxJS.
- Worker usa NestJS `12.0.1` e `pg`.
- Turborepo, ESLint, Prettier e TypeScript estão configurados no workspace.

### Persistência

- `@nexora/database` declara `drizzle-orm` `0.45.2` e `drizzle-kit` `0.31.10`.
- O pacote de banco contém o schema Drizzle e os comandos de geração/verificação/migração.
- A API utiliza `pg` diretamente para seus serviços transacionais; isso é compatível com a separação arquitetural em que `packages/database` é o proprietário do schema/migrations.

**Conclusão:** o item anterior que classificava Drizzle como possível ausência de implementação estava incorreto e foi encerrado como discrepância de manifesto da aplicação, não como ausência da tecnologia no projeto.

### Isolamento multi-tenant

- `TenantContext` é request-scoped e impede substituição do contexto dentro da mesma requisição.
- `TenantContextGuard` exige principal autenticado, UUID de tenant e membership ativa antes de estabelecer o contexto.
- `TenantDatabaseService` executa transações em conexão dedicada do pool e aplica `set_config('app.user_id', ..., true)`, `set_config('app.tenant_id', ..., true)` e `set_config('app.integration_client_id', ..., true)` dentro de `BEGIN`; o terceiro argumento `true` mantém as configurações limitadas à transação.
- O teste de integração existente valida identidade `nexora_app`, ausência de `BYPASSRLS`, isolamento de leitura e rejeição de escrita cross-tenant.
- As tabelas de domínio auditadas possuem RLS e políticas `USING`/`WITH CHECK` baseadas no contexto de tenant.

**Conclusão:** não foi confirmado o P1 inicialmente suspeitado de vazamento de contexto por reutilização do pool. O mecanismo observado é transacional e libera a conexão somente após `COMMIT`/`ROLLBACK`.

**Ponto de melhoria:** o teste de integração de RLS existe, porém não faz parte da coleta automática de `*.spec.ts` usada pelo script padrão de testes da API. Deve ser integrado a uma suíte de integração executável em ambiente de banco controlado antes do fechamento definitivo do hardening multi-tenant.

## 3. Pontos que exigem reconciliação

### Zod

A documentação define Zod como validação de boundary. O código/manifests auditados não demonstram uso efetivo de `zod`.

**Classificação:** P1 documental/implementação.  
**Ação:** decidir entre implementar Zod nos boundaries previstos ou atualizar a arquitetura/documentação para a estratégia de validação realmente adotada.

### Schema físico

A arquitetura define tenant isolation, RLS e migrations versionadas. O catálogo físico final só pode ser emitido após inventário das migrations/SQL realmente presentes e validação em banco vazio.

**Classificação:** P1 de rastreabilidade.  
**Ação:** gerar catálogo automaticamente a partir do histórico SQL/Drizzle e validar em banco vazio.

### API completa

A documentação define `/api/v1` e uma matriz de recursos. Isso é contrato arquitetural e não comprova que todos os endpoints estejam implementados.

**Classificação:** P1 de rastreabilidade.  
**Ação:** gerar inventário real de controllers/routes e comparar com OpenAPI e matriz documental.

## 4. Regra para fechamento

Nenhum item acima deve ser marcado como concluído apenas por existir na documentação. O fechamento exige evidência no código, manifest, migration, teste ou ambiente correspondente.

## 5. Próxima sequência técnica

1. inventariar `apps/*` e `packages/*`;
2. localizar migrations/SQL e construir schema inventory;
3. integrar o teste de isolamento RLS à execução automatizada de integração;
4. identificar controllers/routes reais;
5. gerar OpenAPI inventory;
6. mapear cada endpoint para bounded context;
7. reconciliar Zod com a implementação real;
8. executar typecheck/lint/test/build;
9. atualizar documentação somente com fatos verificados;
10. gerar ERD físico a partir do schema efetivo;
11. fechar P0/P1 restantes.
