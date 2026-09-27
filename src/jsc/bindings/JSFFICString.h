#pragma once

#include "root.h"
#include "BunClientData.h"

#include <JavaScriptCore/InternalFunction.h>

namespace Bun {

using namespace JSC;

class JSFFICStringConstructor final : public JSC::InternalFunction {
public:
    using Base = JSC::InternalFunction;
    // `new CString(ptr)` evaluates to a string primitive, which no constructor may return. So CString is not a
    // constructor to anything that asks first (Array.of, Array.from, species, Reflect.construct, bind, Proxy, extends).
    static constexpr unsigned StructureFlags = Base::StructureFlags | JSC::ReportsNoConstructData;
    static constexpr JSC::DestructionMode needsDestruction = JSC::DoesNotNeedDestruction;

    DECLARE_INFO;

    static JSFFICStringConstructor* create(JSC::VM&, JSC::JSGlobalObject*);

    static JSC::Structure* createStructure(JSC::VM& vm, JSC::JSGlobalObject* globalObject, JSC::JSValue prototype)
    {
        return Bun::createClassStructure(vm, globalObject, prototype, JSC::TypeInfo(JSC::InternalFunctionType, StructureFlags), info());
    }

private:
    JSFFICStringConstructor(JSC::VM& vm, JSC::Structure* structure);
    void finishCreation(JSC::VM&);
};

}
