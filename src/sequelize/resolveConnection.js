// @flow
module.exports = async function resolveConnection (dbModel, args) {
  let {after, first = 100, before, last, group, include = [], condition = {}, sort = [{
    field: 'id',
    order: 'ASC'
  }]} = args
  let reverse = false
  const count = await dbModel.count({
    include: include,
    where: condition
  })
  if (last || before) {
    reverse = true
    first = last || 100
    before = before || (count + 1)
    after = count - (parseInt(before) - 1)
    sort = sort.map(s => {
      return {
        field: s.field,
        order: (s.order === 'ASC' ? 'DESC' : 'ASC')
      }
    })
  }
  const offset = Math.max(after != null ? parseInt(after) : 0, 0)

  let sequelizeOptions = {
    include: include,
    where: condition,
    order: sort.map(s => [s.field, s.order]),
    limit: first,
    offset: offset
  }
  if (group) {
    sequelizeOptions.group = group
  }

  const result = await dbModel.findAll(sequelizeOptions)
  // console.log('fr:',result)

  let index = 0
  let startCursor = offset + 1
  let endCursor = offset + result.length
  if (reverse) {
    startCursor = count - startCursor + 1
    endCursor = count - endCursor + 1
  }
  return {
    pageInfo: {
      startCursor: startCursor,
      endCursor: endCursor,
      hasPreviousPage: offset > 0,
      hasNextPage: offset + result.length < count
    },
    edges: reverse ? result.map(node => {
      return {
        node: node,
        cursor: count - (offset + (index++))
      }
    }).reverse() : result.map(node => {
      return {
        node: node,
        cursor: offset + (++index)
      }
    }),
    count: count
  }
}
